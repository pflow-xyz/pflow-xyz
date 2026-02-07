package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const deployVersion = "2026-02-07a"

func deploySecret() string {
	return os.Getenv("DEPLOY_SECRET")
}

func workspaceRoot() string {
	if v := os.Getenv("WORKSPACE_ROOT"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Workspace")
}

func tmuxSession() string {
	if v := os.Getenv("TMUX_SESSION"); v != "" {
		return v
	}
	return "servers"
}

func serviceName() string {
	if v := os.Getenv("SERVICE_NAME"); v != "" {
		return v
	}
	return "pflow-xyz"
}

// verifyHMAC checks the GitHub X-Hub-Signature-256 header against the request body.
func verifyHMAC(secret string, body []byte, signature string) bool {
	if !strings.HasPrefix(signature, "sha256=") {
		return false
	}
	sig, err := hex.DecodeString(signature[7:])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := mac.Sum(nil)
	return hmac.Equal(sig, expected)
}

// checkDeployAuth validates the deploy token from header or query param.
func checkDeployAuth(r *http.Request) bool {
	secret := deploySecret()
	if secret == "" {
		return false
	}
	if token := r.Header.Get("X-Deploy-Token"); token == secret {
		return true
	}
	if token := r.URL.Query().Get("token"); token == secret {
		return true
	}
	return false
}

// handleWebhook handles GitHub push webhook events.
func handleWebhook(w http.ResponseWriter, r *http.Request) {
	secret := deploySecret()
	if secret == "" {
		http.Error(w, "deploy not configured", http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	sig := r.Header.Get("X-Hub-Signature-256")
	if !verifyHMAC(secret, body, sig) {
		http.Error(w, "invalid signature", http.StatusForbidden)
		return
	}

	var payload struct {
		Ref string `json:"ref"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	if payload.Ref != "refs/heads/main" {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, "ignored: %s", payload.Ref)
		return
	}

	go func() {
		log.Printf("[deploy] webhook triggered for %s", payload.Ref)
		output, err := runDeploySync()
		if err != nil {
			log.Printf("[deploy] failed: %v\n%s", err, output)
			return
		}
		log.Printf("[deploy] success, scheduling restart")
		scheduleRestart()
	}()

	w.WriteHeader(http.StatusAccepted)
	fmt.Fprintf(w, "deploy started")
}

// handleAdminDeploy handles manual deploy trigger.
func handleAdminDeploy(w http.ResponseWriter, r *http.Request) {
	if !checkDeployAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(5 * time.Minute))

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	write := func(msg string) {
		fmt.Fprint(w, msg)
		flusher.Flush()
	}

	write("Starting deploy...\n\n")

	output, err := runDeploySync()
	write(output)

	if err != nil {
		write(fmt.Sprintf("\nDEPLOY FAILED: %v\n", err))
		return
	}

	write("\nDeploy succeeded. Scheduling restart in 2s...\n")
	flusher.Flush()

	go scheduleRestart()
}

// handleAdminLogs reads recent log output from tmux.
func handleAdminLogs(w http.ResponseWriter, r *http.Request) {
	if !checkDeployAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	lines := 100
	if v := r.URL.Query().Get("lines"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > 1000 {
				n = 1000
			}
			lines = n
		}
	}

	target := fmt.Sprintf("%s:%s", tmuxSession(), serviceName())
	cmd := exec.Command("tmux", "capture-pane", "-t", target, "-p", "-S", fmt.Sprintf("-%d", lines))
	out, err := cmd.CombinedOutput()
	if err != nil {
		http.Error(w, fmt.Sprintf("tmux error: %v\n%s", err, out), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(out)
}

// runDeploySync runs the full deploy sequence and returns combined output.
func runDeploySync() (string, error) {
	var buf strings.Builder
	root := workspaceRoot()
	projectDir := filepath.Join(root, "pflow-xyz")

	run := func(dir, desc string, args ...string) error {
		buf.WriteString(fmt.Sprintf("==> %s\n", desc))
		buf.WriteString(fmt.Sprintf("    cd %s && %s\n", dir, strings.Join(args, " ")))

		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		buf.Write(out)
		buf.WriteString("\n")

		if err != nil {
			return fmt.Errorf("%s: %w", desc, err)
		}
		return nil
	}

	if err := run(projectDir, "git pull", "git", "pull", "--ff-only"); err != nil {
		return buf.String(), err
	}

	// Copy public assets to internal/static for embedding
	if err := run(projectDir, "copy public assets", "bash", "-c", "rm -rf internal/static/public && cp -r public internal/static/"); err != nil {
		return buf.String(), err
	}

	if err := run(projectDir, "go build", "go", "build", "-o", "bin/webserver", "./cmd/webserver"); err != nil {
		return buf.String(), err
	}

	buf.WriteString("==> Build complete\n")
	return buf.String(), nil
}

// scheduleRestart waits briefly then triggers a service restart and exits.
func scheduleRestart() {
	time.Sleep(2 * time.Second)

	home, _ := os.UserHomeDir()
	servicesScript := filepath.Join(home, "services")

	log.Printf("[deploy] restarting %s via %s", serviceName(), servicesScript)

	cmd := exec.Command("nohup", servicesScript, "restart", serviceName())
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Printf("[deploy] restart failed: %v", err)
		return
	}
	_ = cmd.Process.Release()

	log.Printf("[deploy] exiting for restart")
	os.Exit(0)
}
