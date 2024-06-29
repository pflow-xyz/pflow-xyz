package main

import (
	rice "github.com/GeertJohan/go.rice"
	"github.com/pflow-dev/pflow-xyz/internal/service"
	"github.com/pflow-dev/pflow-xyz/internal/storage"
	"github.com/pflow-dev/pflow-xyz/protocol/server"
	"os"
)

var (
	options = service.Options{
		Host:            "127.0.0.1",
		Port:            "8083",
		Url:             "http://localhost:8083",
		DbPath:          "/tmp/pflow.db",
		NewRelicApp:     "pflow.dev",
		NewRelicLicense: os.Getenv("NEW_RELIC_LICENSE"),
		LoadExamples:    true,
	}
)

func main() {
	dbPath, pathSet := os.LookupEnv("DB_PATH")
	if pathSet {
		options.DbPath = dbPath
	}
	baseUrl, urlSet := os.LookupEnv("URL_BASE")
	if urlSet {
		options.Url = baseUrl
	}
	listenPort, portSet := os.LookupEnv("PORT")
	if portSet {
		options.Port = listenPort
	}
	listenHost, hostSet := os.LookupEnv("HOST")
	if hostSet {
		options.Host = listenHost
	}
	store := storage.New(storage.ResetDb(options.DbPath))

	s := service.New(server.Storage{
		Model:   store.Model,
		Snippet: store.Snippet,
	}, options)

	if options.LoadExamples {
		// for _, m := range examples.ExampleModels {
		// 	_, _ = store.Model.Create(m.IpfsCid, m.Base64Zipped, m.Title, m.Description, m.Keywords, "http://localhost:8083/p/")
		// 	foundModel := store.Model.GetByCid(m.IpfsCid)
		// 	if foundModel.IpfsCid != m.IpfsCid {
		// 		panic(fmt.Sprintf("Failed to load model %s %s", m.Title, m.IpfsCid))
		// 	}
		// 	s.PrintLinks(*model.FromZblob(foundModel), options.Url)
		// }
		// s.Logger.Print("Loaded example models")
	}
	s.ServeHTTP(rice.MustFindBox("./public"))
}
