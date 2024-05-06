package service

import (
	"encoding/json"
	rice "github.com/GeertJohan/go.rice"
	"github.com/gorilla/mux"
	"github.com/newrelic/go-agent/v3/integrations/logcontext-v2/logWriter"
	"github.com/newrelic/go-agent/v3/newrelic"
	"github.com/pflow-dev/pflow-xyz/config"
	"github.com/pflow-dev/pflow-xyz/protocol/compression"
	"github.com/pflow-dev/pflow-xyz/protocol/metamodel"
	"github.com/pflow-dev/pflow-xyz/protocol/model"
	"github.com/pflow-dev/pflow-xyz/protocol/oid"
	"github.com/pflow-dev/pflow-xyz/protocol/server"
	"html/template"
	"log"
	"net/http"
	"os"
)

type Options struct {
	Port            string
	Host            string
	Url             string
	DbPath          string
	NewRelicLicense string
	NewRelicApp     string
	LoadExamples    bool
}

type Server struct {
	App       *server.App
	Logger    *log.Logger
	Options   Options
	Router    *mux.Router
	indexPage *template.Template
	apm       *newrelic.Application
}

func New(store server.Storage, options Options) *Server {
	s := &Server{
		Options: options,
		Router:  mux.NewRouter(),
	}
	s.App = &server.App{
		Service: s,
		Storage: store,
	}
	if s.Options.NewRelicLicense != "" {
		s.apm, _ = newrelic.NewApplication(
			newrelic.ConfigAppName(s.Options.NewRelicApp),
			newrelic.ConfigLicense(s.Options.NewRelicLicense),
			newrelic.ConfigAppLogForwardingEnabled(true),
		)
		writer := logWriter.New(os.Stdout, s.apm)
		s.Logger = log.New(writer, "", log.Default().Flags())
		s.Logger.Printf("NewRelic license set, APM enabled %s\n", s.Options.NewRelicApp)
	} else {
		s.Logger = log.Default()
		s.Logger.Print("NewRelic license not set, skipping APM, disable browser tracking\n")
	}
	indexSource := s.IndexTemplateSource()
	s.indexPage = template.Must(template.New("index.html").Parse(indexSource))

	s.Logger.Printf("DBPath: %s\n", s.Options.DbPath)
	s.Logger.Printf("Listening on %s:%s\n", s.Options.Host, s.Options.Port)
	return s
}

func (s *Server) IndexPage() *template.Template {
	return s.indexPage
}

func (s *Server) PrintLinks(m model.Model, url string) {
	s.Logger.Printf("- model[%d] %s\n", m.ID, m.Title)
	s.Logger.Printf("  %s/p/%s/\n", url, m.IpfsCid)
	s.Logger.Printf("  %s/src/%s.json\n", url, m.IpfsCid)
	s.Logger.Printf("  %s/img/%s.svg\n", url, m.IpfsCid)
}

func staticRouteFactory(box *rice.Box, path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		http.StripPrefix(path, http.FileServer(box.HTTPBox())).ServeHTTP(w, r)
	}
}

func (s *Server) ServeHTTP(box *rice.Box) {
	s.WrapHandler("/p/", s.App.AppPage)
	s.WrapHandler("/p/{pflowCid}/", s.App.AppPage)
	s.WrapHandler("/img/", s.App.SvgHandler)
	s.WrapHandler("/img/{pflowCid}.svg", s.App.SvgHandler)
	s.WrapHandler("/src/", s.App.JsonHandler)
	s.WrapHandler("/src/{pflowCid}.json", s.App.JsonHandler)
	s.WrapHandler("/_webhook/0x{contract}", s.App.WebHookHandler)

	s.Router.HandleFunc("/p/{file}", staticRouteFactory(box, "/p/"))

	s.Router.HandleFunc("/p/static/js/{jsBuild}",
		func(w http.ResponseWriter, r *http.Request) {
			vars := mux.Vars(r)
			f, boxErr := box.Open("static/js/" + vars["jsBuild"])
			if boxErr != nil {
				http.Error(w, boxErr.Error(), http.StatusNotFound)
				return
			}

			fileInfo, fileErr := f.Stat()
			if fileErr != nil {
				http.Error(w, fileErr.Error(), http.StatusNotFound)
				return
			}
			http.ServeContent(w, r, "main."+vars["jsBuild"]+".js", fileInfo.ModTime(), f)
		})

	s.Router.HandleFunc("/p/static/css/{cssBuild}",
		func(w http.ResponseWriter, r *http.Request) {
			vars := mux.Vars(r)
			f, boxErr := box.Open("static/css/" + vars["cssBuild"])
			if boxErr != nil {
				http.Error(w, boxErr.Error(), http.StatusNotFound)
				return
			}
			fileInfo, fileErr := f.Stat()
			if fileErr != nil {
				http.Error(w, fileErr.Error(), http.StatusNotFound)
				return
			}
			http.ServeContent(w, r, "main."+vars["cssBuild"]+".css", fileInfo.ModTime(), f)
		})

	s.Router.HandleFunc("/p/{pflowCid}/static/media/brotli_wasm_bg.{version}.wasm",
		func(w http.ResponseWriter, r *http.Request) {
			// redirect to the correct wasm file
			http.Redirect(w, r, "/p/static/media/brotli_wasm_bg."+mux.Vars(r)["version"]+".wasm", http.StatusFound)
		})

	s.Router.HandleFunc("/p/static/media/brotli_wasm_bg.{version}.wasm",
		func(w http.ResponseWriter, r *http.Request) {
			vars := mux.Vars(r)
			f, boxErr := box.Open("static/media/brotli_wasm_bg." + vars["version"] + ".wasm")
			if boxErr != nil {
				http.Error(w, boxErr.Error(), http.StatusNotFound)
				return
			}
			fileInfo, fileErr := f.Stat()
			if fileErr != nil {
				http.Error(w, fileErr.Error(), http.StatusNotFound)
				return
			}
			http.ServeContent(w, r, "brotli_wasm_bg."+vars["version"]+".wasm", fileInfo.ModTime(), f)
		})

	err := http.ListenAndServe(s.Options.Host+":"+s.Options.Port, s.Router)
	if err != nil {
		panic(err)
	}
}

func (s *Server) WrapHandler(pattern string, handler server.HandlerWithVars) {
	if s.apm != nil {
		s.Router.HandleFunc(newrelic.WrapHandleFunc(s.apm, pattern, func(w http.ResponseWriter, r *http.Request) {
			vars := mux.Vars(r)
			handler(vars, w, r)
		}))
	} else {
		s.Router.HandleFunc(
			pattern,
			func(w http.ResponseWriter, r *http.Request) {
				vars := mux.Vars(r)
				handler(vars, w, r)
			})
	}
}
func (s *Server) Event(eventType string, params map[string]interface{}) {
	if s.apm != nil {
		s.apm.RecordCustomEvent(eventType, params)
	}
	data, _ := json.Marshal(params)
	s.Logger.Printf("event %s %s\n", eventType, data)
}
func (s *Server) CheckForModel(hostname string, url string, referrer string) (string, bool) {
	defer func() {
		if r := recover(); r != nil {
			s.Logger.Printf("Recovered from panic in CheckForModel: %v", r)
		}
	}()
	mm := metamodel.New()
	_, foundInUrl := mm.UnpackFromUrl(url)
	if foundInUrl {
		zippedData, _ := mm.ZipUrl()
		zippedData = zippedData[3:]
		cid := oid.ToOid(oid.Marshal(zippedData)).String()
		id, err := s.App.Model.Create(cid, zippedData, "Untitled", "", "", referrer)
		if err != nil {
			id = s.App.Model.GetByCid(cid).ID
		}
		linkUrl := "https://" + hostname + "/p/" + cid + "/"
		s.Event("modelUnzipped", map[string]interface{}{
			"id":       id,
			"cid":      cid,
			"link":     linkUrl,
			"referrer": referrer,
		})
		return cid, true
	}
	return "", false
}

func (s *Server) CheckForSnippet(hostname string, url string, referrer string) (string, bool) {
	defer func() {
		if r := recover(); r != nil {
			s.Logger.Printf("Recovered from panic in CheckForSnippet: %v", r)
		}
	}()
	srcUrl := "https://" + hostname + url
	sourceCode, foundInUrl := compression.DecompressEncodedUrl(srcUrl)
	if !foundInUrl {
		// try to convert a model to a snippet
		// REVIEW: do we want to continue support for snippets
	}
	cid := oid.ToOid(oid.Marshal(sourceCode)).String()
	zippedCode, _ := compression.CompressBrotliEncode([]byte(sourceCode))
	_, err := s.App.Storage.Snippet.Create(cid, zippedCode, "", "", "", referrer)
	if err != nil {
		http.Error(nil, "Failed to create snippet", http.StatusInternalServerError)
		return "", false
	}
	res := s.App.Storage.Snippet.GetByCid(cid)
	if res.IpfsCid != cid {
		http.Error(nil, "Failed to load snippet by cid", http.StatusInternalServerError)
		return "", false
	}
	linkUrl := "https://" + hostname + "/sandbox/" + cid + "/"
	s.Event("sandboxUnzipped", map[string]interface{}{
		"id":       res.ID,
		"cid":      cid,
		"link":     linkUrl,
		"referrer": referrer,
	})
	return cid, true
}

func (*Server) GetState(r *http.Request) (state metamodel.Vector, ok bool) {
	q := r.URL.Query()
	rawState := q.Get("state")
	if rawState != "" {
		err := oid.Unmarshal([]byte(rawState), &state)
		if err != nil {
			return state, false
		}
		return state, true
	} else {
		return state, false
	}
}

func (s *Server) IndexTemplateSource() string {
	out := `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
	<title>pflow | metamodel explorer</title>
	<meta name="viewport" content="width=device-width,initial-scale=1"/>
	<meta name="theme-color" content="#000000"/>
	<meta name="description" content="pflow metamodel editor"/>
	<link rel="icon" href="/p/favicon.ico"/>
	<link rel="apple-touch-icon" href="/p/logo192.png"/>
	<link rel="manifest" href="/p/manifest.json"/>
	<link href="/p/static/css/main.` + config.CssBuild + `.css" rel="stylesheet">`
	out += SessionDataScript
	out += `<script defer="defer" src=/p/static/js/main.` + config.JsBuild + `.js></script>
</head>
<body>
	<noscript>You need to enable JavaScript to run this app.</noscript>
	<div id="root"></div>
</body></html>`
	return out
}

const (
	SessionDataScript = `<script>
	sessionStorage.cid = "{{.IpfsCid}}";
	sessionStorage.data = "{{.Base64Zipped}}";
</script>`
)
