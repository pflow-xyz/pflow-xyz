package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/pflow-dev/pflow-xyz/protocol/compression"
	"github.com/pflow-dev/pflow-xyz/protocol/image"
	"github.com/pflow-dev/pflow-xyz/protocol/metamodel"
	"github.com/pflow-dev/pflow-xyz/protocol/model"
	"github.com/pflow-dev/pflow-xyz/protocol/zblob"
	"html/template"
	"net/http"
	"strings"
)

type HandlerWithVars = func(vars map[string]string, w http.ResponseWriter, r *http.Request)

type VarsFactory = func(r *http.Request) map[string]string

func WithVars(handler HandlerWithVars, getVarsFunc VarsFactory) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		handler(getVarsFunc(r), w, r)
	}
}

type BlobAccessor interface {
	Get(id int64) *zblob.Zblob
	GetByCid(cid string) *zblob.Zblob
	GetMaxId() int64
	Create(ipfsCid, base64Zipped, title, description, keywords, referrer string) (int64, error)
}

type Storage struct {
	Model   BlobAccessor
	Snippet BlobAccessor
}

type Service interface {
	IndexPage() *template.Template
	Event(eventType string, params map[string]interface{})
	GetState(r *http.Request) (state metamodel.Vector, ok bool)
	CheckForSnippet(hostname string, url string, referrer string) (string, bool)
	CheckForModel(hostname string, url string, referrer string) (string, bool)
}

type App struct {
	Service
	Storage
}

func (app *App) AppPage(vars map[string]string, w http.ResponseWriter, r *http.Request) {
	cid, found := app.CheckForModel(r.Host, r.URL.String(), r.Header.Get("Referer"))
	if found {
		http.Redirect(w, r, "/p/"+cid+"/", http.StatusFound)
		return
	}
	m := model.Model{
		Zblob: &zblob.Zblob{
			IpfsCid: cid,
		},
	}
	if vars["pflowCid"] != "" {
		m = *model.FromZblob(app.Storage.Model.GetByCid(vars["pflowCid"]))
		if m.ID != 0 && m.IpfsCid == vars["pflowCid"] {
			m.MetaModel()
		}
	}
	err := app.IndexPage().ExecuteTemplate(w, "index.html", m.Zblob)
	if err != nil {
		return
	}
}

func (app *App) SvgHandler(vars map[string]string, w http.ResponseWriter, r *http.Request) {
	cid, found := app.CheckForModel(r.Host, r.URL.String(), r.Header.Get("Referer"))
	if found {
		http.Redirect(w, r, "/img/"+cid+".svg", http.StatusFound)
		return
	}
	if vars["pflowCid"] == "" {
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml ; charset=utf-8")
	m := model.FromZblob(app.Storage.Model.GetByCid(vars["pflowCid"]))
	_, mm := m.MetaModel()
	if m.IpfsCid != vars["pflowCid"] {
		return
	}
	app.Event("viewSvg", map[string]interface{}{
		"id":      m.ID,
		"ipfsCid": m.IpfsCid,
	})
	x1, y1, width, height := mm.GetViewPort()
	i := image.NewSvg(w, width, height, x1, y1, width, height)

	state, stateOk := app.GetState(r)
	if !stateOk || len(state) != len(mm.Net().Places) {
		state = mm.Net().InitialVector()
	}
	i.Render(mm, state)
}

func (app *App) JsonHandler(vars map[string]string, w http.ResponseWriter, r *http.Request) {
	mm := metamodel.New()
	cid, found := app.CheckForModel(r.Host, r.URL.String(), r.Header.Get("Referer"))
	if found {
		http.Redirect(w, r, "/src/"+cid+".json", http.StatusFound)
	} else if vars["pflowCid"] != "" {
		m := app.Storage.Model.GetByCid(vars["pflowCid"])
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		mm.UnpackFromUrl("?z=" + m.Base64Zipped)
		data, _ := json.MarshalIndent(mm.ToDeclarationObject(), "", "  ")
		_, err := w.Write(data)
		if err != nil {
			panic(err)
		}
	}
}

// REVIEW: https://www.quicknode.com/docs/quickalerts/quickalerts-destinations/webhooks/webhook-payload-types#evm-payload-types
func (app *App) WebHookHandler(vars map[string]string, w http.ResponseWriter, r *http.Request) {
	_ = vars
	_ = w
	secret := "qnsec_Z7dAfqmoQvGfLSa0TTOt9A=="
	givenSign := r.Header.Get("x-qn-signature")
	nonce := r.Header.Get("x-qn-nonce")
	contentHash := r.Header.Get("x-qn-content-hash")
	timestamp := r.Header.Get("x-qn-timestamp")

	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(nonce + contentHash + timestamp))

	expectedSign := base64.StdEncoding.EncodeToString(h.Sum(nil))

	if strings.Compare(givenSign, expectedSign) == 0 {
		fmt.Println("The signature given matches the expected signature and is valid.")
	} else {
		fmt.Println("The signature given does not match the expected signature and is invalid.")
	}

	body := make([]byte, r.ContentLength)
	_, _ = r.Body.Read(body)
	fmt.Printf("body: %s\n", body)

}

func (app *App) SandboxHandler(vars map[string]string, w http.ResponseWriter, r *http.Request) {
	// TODO: replace with solidity sandbox
	cid, found := app.CheckForSnippet(r.Host, r.URL.String(), r.Header.Get("Referer"))
	if found {
		http.Redirect(w, r, "/sandbox/"+cid+"/", http.StatusFound)
		return
	}
	templateData := struct {
		IpfsCid    string
		SourceCode string
	}{
		IpfsCid:    vars["pflowCid"],
		SourceCode: "",
	}
	if vars["pflowCid"] != "" {
		rec := app.Storage.Snippet.GetByCid(vars["pflowCid"])
		templateData.SourceCode, _ = compression.DecompressEncodedUrl("?z=" + rec.Base64Zipped)
	}
}
