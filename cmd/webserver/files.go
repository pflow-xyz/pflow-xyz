package main

// Account files: /api/files, the signed-in user's own file space
// (internal/userfiles, docs/account-files.md). pflow-native writes to the
// user's disk (file.save, export.svg/png/artifact with a path); a page has no
// disk, so the editor's file.save / file.write / export.artifact {name} save
// here instead, over HTTPS, under the account they are signed in as.
//
//   GET    /api/files          {files: [{name, size, modified, kind}], usage, limits}
//   GET    /api/files/{name}   the file's bytes, with its type
//   PUT    /api/files/{name}   the body becomes the file: 201 created; 409 when the
//                              name exists, unless ?overwrite=true (200 replaced)
//   DELETE /api/files/{name}   200 {deleted}, 404 when there is no such file
//
// Every route needs a signed-in user (401, never a shared bucket) and is
// same-origin only: no handleCORS, as /api/llm/*, and a request a browser made
// from another site is refused before anything is read or written.

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/pflow-xyz/pflow-xyz/internal/auth"
	"github.com/pflow-xyz/pflow-xyz/internal/userfiles"
)

const filesPrefix = "/api/files"

// filesSignInMsg is the 401 answer: the editor shows it as is.
const filesSignInMsg = "sign in to save: files are kept in your own account, and this request is not signed in"

var (
	// errFilesSignedOut: no token, or one the provider rejected (401).
	errFilesSignedOut = errors.New("not signed in")
	// errFilesAuthUnavailable: the provider could not be asked (503, fail closed).
	errFilesAuthUnavailable = errors.New("sign-in could not be checked")
)

// fileAccountResolver is the identity seam: it turns a request into the
// account it is signed in as, provider-qualified, or one of the two errors
// above. Today that is a GitHub token (githubFileAccounts). Another sign-in
// (PR #111's Google accounts, "google:<sub>") is another resolver tried in
// front of it; its owners get their own directories, so nothing stored moves.
type fileAccountResolver func(r *http.Request) (userfiles.Owner, error)

// githubFileAccounts identifies a GitHub bearer token through v (the timeout +
// cache verifier in production), as "github:<numeric user id>".
func githubFileAccounts(v auth.Verifier) fileAccountResolver {
	return func(r *http.Request) (userfiles.Owner, error) {
		token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if token == "" {
			return userfiles.Owner{}, errFilesSignedOut
		}
		u, err := v.Verify(r.Context(), token)
		switch {
		case errors.Is(err, auth.ErrVerifierUnavailable):
			return userfiles.Owner{}, errFilesAuthUnavailable
		case err != nil:
			return userfiles.Owner{}, errFilesSignedOut
		}
		// The numeric id, never the login (a login can be renamed and reused).
		if u.GitHubID == "" || strings.Trim(u.GitHubID, "0123456789") != "" {
			return userfiles.Owner{}, errFilesSignedOut
		}
		return userfiles.Owner{Provider: "github", Subject: u.GitHubID}, nil
	}
}

// fileService is /api/files' store and its sign-in check.
type fileService struct {
	store    *userfiles.Store
	accounts fileAccountResolver
}

// configureFiles keeps account files under <data>/files, signed in with GitHub.
func (s *Server) configureFiles(dataDir string) {
	limits := userfiles.LimitsFromEnv(os.Getenv)
	s.files = &fileService{
		store:    userfiles.New(filepath.Join(dataDir, "files"), limits),
		accounts: githubFileAccounts(auth.NewCachingVerifier(auth.NewGitHubVerifier())),
	}
	log.Printf("Account files: %s (%d B a file, %d files, %d B per account)", filepath.Join(dataDir, "files"), limits.MaxFileBytes, limits.MaxFiles, limits.MaxTotalBytes)
}

// filesSameOrigin reports whether a request may come from where it does.
// Sec-Fetch-Site is set by the browser and cannot be forged by a page, so it
// decides when present; otherwise an Origin must name this host. A request
// with neither (curl, pflow-native) is not a page's, and its token alone
// decides. Nothing here is a credential: the token is a header a cross-origin
// page cannot attach without a preflight these routes never pass.
func filesSameOrigin(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-origin":
		return true
	case "cross-site", "same-site":
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false // includes "null" (sandboxed frames, file: pages)
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	fh := r.Header.Get("X-Forwarded-Host")
	return fh != "" && strings.EqualFold(u.Host, fh)
}

func filesError(w http.ResponseWriter, status int, msg string, extra map[string]any) {
	body := map[string]any{"error": msg}
	for k, v := range extra {
		body[k] = v
	}
	writeJSON(w, status, body)
}

func (svc *fileService) limitsJSON() map[string]any {
	l := svc.store.Limits()
	return map[string]any{"max_file_bytes": l.MaxFileBytes, "max_files": l.MaxFiles, "max_total_bytes": l.MaxTotalBytes}
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	svc := s.files
	if svc == nil {
		filesError(w, http.StatusServiceUnavailable, "account files are not configured on this server", nil)
		return
	}
	if !filesSameOrigin(r) {
		filesError(w, http.StatusForbidden, "cross-origin requests to account files are refused", nil)
		return
	}
	// The name is taken from the path as sent, never decoded: a valid name
	// needs no escaping, so any '%' (an encoded slash or dot) makes it invalid.
	rest := strings.TrimPrefix(r.URL.EscapedPath(), filesPrefix)
	isList := rest == "" || rest == "/"
	allowed := r.Method == http.MethodGet || (!isList && (r.Method == http.MethodPut || r.Method == http.MethodDelete))
	if !allowed {
		allow := "GET, PUT, DELETE"
		if isList {
			allow = "GET"
		}
		w.Header().Set("Allow", allow)
		filesError(w, http.StatusMethodNotAllowed, allow+" only", nil)
		return
	}

	owner, err := svc.accounts(r)
	switch {
	case errors.Is(err, errFilesAuthUnavailable):
		log.Printf("[files] sign-in check: %v", err)
		filesError(w, http.StatusServiceUnavailable, "cannot check your sign-in right now; nothing was saved, try again shortly", nil)
		return
	case err != nil:
		filesError(w, http.StatusUnauthorized, filesSignInMsg, nil)
		return
	}

	if isList {
		files, usage, err := svc.store.List(owner)
		if err != nil {
			log.Printf("[files] list %s: %v", owner.Key(), err)
			filesError(w, http.StatusInternalServerError, "could not list your files", nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"files": files, "usage": usage, "limits": svc.limitsJSON()})
		return
	}

	name := strings.TrimPrefix(rest, "/")
	if _, err := userfiles.CheckName(name); err != nil {
		filesError(w, http.StatusBadRequest, err.Error(), map[string]any{"extensions": userfiles.Extensions(), "max_name": userfiles.MaxName})
		return
	}
	switch r.Method {
	case http.MethodGet:
		svc.read(w, owner, name)
	case http.MethodPut:
		svc.write(w, r, owner, name)
	case http.MethodDelete:
		usage, err := svc.store.Delete(owner, name)
		switch {
		case errors.Is(err, userfiles.ErrNotFound):
			filesError(w, http.StatusNotFound, fmt.Sprintf("you have no file named %s", name), nil)
		case err != nil:
			log.Printf("[files] delete %s/%s: %v", owner.Key(), name, err)
			filesError(w, http.StatusInternalServerError, "could not delete the file", nil)
		default:
			writeJSON(w, http.StatusOK, map[string]any{"deleted": name, "usage": usage})
		}
	}
}

func (svc *fileService) read(w http.ResponseWriter, owner userfiles.Owner, name string) {
	data, info, err := svc.store.Read(owner, name)
	switch {
	case errors.Is(err, userfiles.ErrNotFound):
		filesError(w, http.StatusNotFound, fmt.Sprintf("you have no file named %s", name), nil)
		return
	case err != nil:
		log.Printf("[files] read %s/%s: %v", owner.Key(), name, err)
		filesError(w, http.StatusInternalServerError, "could not read the file", nil)
		return
	}
	k, _ := userfiles.CheckName(name)
	h := w.Header()
	h.Set("Content-Type", k.MIME)
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	// A stored SVG is the user's own markup: never let it run as a page here.
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	h.Set("Last-Modified", info.Modified.Format(http.TimeFormat))
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

func (svc *fileService) write(w http.ResponseWriter, r *http.Request, owner userfiles.Owner, name string) {
	overwrite := false
	switch v := r.URL.Query().Get("overwrite"); v {
	case "", "false", "0":
	case "true", "1":
		overwrite = true
	default:
		filesError(w, http.StatusBadRequest, fmt.Sprintf("overwrite=%q: use true or false", v), nil)
		return
	}
	max := svc.store.Limits().MaxFileBytes
	tooLarge := func() {
		filesError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("a file is at most %d bytes", max), map[string]any{"limit": max})
	}
	if r.ContentLength > max {
		tooLarge()
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, max))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			tooLarge()
			return
		}
		filesError(w, http.StatusBadRequest, "could not read the request body", nil)
		return
	}
	info, created, usage, err := svc.store.Write(owner, name, data, overwrite)
	var ce *userfiles.ContentError
	var le *userfiles.LimitError
	switch {
	case errors.Is(err, userfiles.ErrExists):
		filesError(w, http.StatusConflict, fmt.Sprintf("you already have a file named %s; save with overwrite to replace it", name), map[string]any{"name": name})
	case errors.Is(err, userfiles.ErrTooLarge):
		tooLarge()
	case errors.As(err, &ce):
		filesError(w, http.StatusBadRequest, ce.Msg, nil)
	case errors.As(err, &le):
		// 507: the account's storage is full, as WebDAV reports a quota.
		filesError(w, http.StatusInsufficientStorage, le.Error(), map[string]any{"limit": le.Limit, "used": le.Used, "what": le.What})
	case err != nil:
		log.Printf("[files] write %s/%s: %v", owner.Key(), name, err)
		filesError(w, http.StatusInternalServerError, "could not save the file", nil)
	default:
		status := http.StatusOK
		if created {
			status = http.StatusCreated
		}
		writeJSON(w, status, map[string]any{
			"name": info.Name, "size": info.Size, "modified": info.Modified,
			"kind": info.Kind, "created": created, "usage": usage,
		})
	}
}
