package storage

import (
	"database/sql"
	_ "github.com/mattn/go-sqlite3"
	"github.com/pflow-dev/pflow-xyz/protocol/server"
	"github.com/pflow-dev/pflow-xyz/protocol/zblob"
	"log"
)

var (
	tables = []string{
		"pflow_models",
		"pflow_snippets",
	}
)

const (
	emptyModel    = `UEsDBAoAAAAAAMC5PljjbbhPbAAAAGwAAAAKAAAAbW9kZWwuanNvbnsKICAibW9kZWxUeXBlIjogInBldHJpTmV0IiwKICAidmVyc2lvbiI6ICJ2MCIsCiAgInBsYWNlcyI6IHsKICB9LAogICJ0cmFuc2l0aW9ucyI6IHsKICB9LAogICJhcmNzIjogWwogIF0KfVBLAQIUAAoAAAAAAMC5PljjbbhPbAAAAGwAAAAKAAAAAAAAAAAAAAAAAAAAAABtb2RlbC5qc29uUEsFBgAAAAABAAEAOAAAAJQAAAAAAA==`
	emptyModelCid = `zb2rhgff9ScJPXQjbHZoCDD8MeYR5DygH6abycdaDKvSkUn2T`

	emptySnippet    = `UEsDBAoAAAAAAKsOP1iMSISCgAAAAIAAAAAOAAAAZGVjbGFyYXRpb24uanNjb25zdCBkZWNsYXJhdGlvbiA9IHsKICAibW9kZWxUeXBlIjogInBldHJpTmV0IiwKICAidmVyc2lvbiI6ICJ2MCIsCiAgInBsYWNlcyI6IHsKICB9LAogICJ0cmFuc2l0aW9ucyI6IHsKICB9LAogICJhcmNzIjogWwogIF0KfVBLAQIUAAoAAAAAAKsOP1iMSISCgAAAAIAAAAAOAAAAAAAAAAAAAAAAAAAAAABkZWNsYXJhdGlvbi5qc1BLBQYAAAAAAQABADwAAACsAAAAAAA=`
	emptySnippetCid = `zb2rhWyYtJzFxU9HfR7bm5ncgaKFkaWGRQp4KBexeE6CpjgQM`
)

var (
	EmptyModel = &zblob.Zblob{
		Title:        "Empty",
		Description:  "empty petriNet Model",
		Keywords:     "empty",
		Base64Zipped: emptyModel,
		IpfsCid:      emptyModelCid,
	}

	EmptySnippet = &zblob.Zblob{
		Title:        "Empty",
		Description:  "empty js Snippet",
		Keywords:     "empty",
		Base64Zipped: emptySnippet,
		IpfsCid:      emptySnippetCid,
	}
)

func CreateTables(db *sql.DB) {
	for _, tableName := range tables {
		CreateBlobTable(db, tableName)
	}
}
func ResetDb(dbpath string, dropTables ...bool) *sql.DB {
	db := ConnectDb(dbpath)
	if len(dropTables) > 0 && dropTables[0] {
		for _, tableName := range tables {
			_, err := db.Exec("DROP TABLE IF EXISTS " + tableName)
			if err != nil {
				panic(err)
			}
		}
	}
	CreateTables(db)
	return db
}

func CreateBlobTable(db *sql.DB, tableName string) {
	createSql := `
	CREATE TABLE IF NOT EXISTS ` + tableName + ` (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ipfs_cid TEXT UNIQUE,
		base64_zipped BLOB,
		title TEXT,
		description TEXT,
		keywords TEXT,
		referrer TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);`

	_, err := db.Exec(createSql)
	if err != nil {
		panic(err)
	}
}

func ConnectDb(dbPath string) *sql.DB {
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		log.Fatal(err)
	}
	return db
}

type Storage struct {
	db      *sql.DB
	Model   server.BlobAccessor
	Snippet server.BlobAccessor
}

func New(db *sql.DB) *Storage {
	return &Storage{
		db:      db,
		Model:   NewModelTable(db),
		Snippet: NewSnippetTable(db),
	}
}

type ModelTable struct {
	db *sql.DB
}

func NewModelTable(db *sql.DB) ModelTable {
	return ModelTable{db: db}
}

func (m ModelTable) Get(id int64) *zblob.Zblob {
	row := new(zblob.Zblob)
	res := m.db.QueryRow("SELECT * FROM pflow_models WHERE id = ?", id)
	err := res.Scan(&row.ID, &row.IpfsCid, &row.Base64Zipped, &row.Title, &row.Description, &row.Keywords, &row.Referer, &row.CreatedAt)
	if err != nil {
		log.Fatal(err)
	}
	return nil
}
func (m ModelTable) GetByCid(cid string) *zblob.Zblob {
	row := new(zblob.Zblob)
	res := m.db.QueryRow("SELECT * FROM pflow_models WHERE ipfs_cid = ?", cid)
	err := res.Scan(&row.ID, &row.IpfsCid, &row.Base64Zipped, &row.Title, &row.Description, &row.Keywords, &row.Referer, &row.CreatedAt)
	if err != nil {
		return EmptyModel
	}
	return row
}
func (m ModelTable) GetMaxId() int64 {
	row := m.db.QueryRow("SELECT MAX(id) FROM pflow_models")
	var maxId int64
	err := row.Scan(&maxId)
	if err != nil {
		log.Fatal(err)
	}
	return maxId
}
func (m ModelTable) Create(ipfsCid, base64Zipped, title, description, keywords, referrer string) (int64, error) {
	stmt, err := m.db.Prepare("INSERT INTO pflow_models(ipfs_cid, base64_zipped, title, description, keywords, referrer) values(?,?,?,?,?,?)")
	if err != nil {
		log.Fatal(err)
	}
	res, err := stmt.Exec(ipfsCid, base64Zipped, title, description, keywords, referrer)
	if err != nil {
		if err.Error() == "UNIQUE constraint failed: pflow_models.ipfs_cid" {
			return m.GetByCid(ipfsCid).ID, nil
		}
	}
	id, err := res.LastInsertId()
	if err != nil {
		log.Fatal(err)
	}
	return id, nil
}

type SnippetTable struct {
	db *sql.DB
}

func NewSnippetTable(db *sql.DB) SnippetTable {
	return SnippetTable{db: db}
}

func (m SnippetTable) Get(id int64) *zblob.Zblob {
	row := m.db.QueryRow("SELECT * FROM pflow_snippets WHERE id = ?", id)
	zblob := new(zblob.Zblob)
	err := row.Scan(&zblob.ID, &zblob.IpfsCid, &zblob.Base64Zipped, &zblob.Title, &zblob.Description, &zblob.Keywords, &zblob.Referer, &zblob.CreatedAt)
	if err != nil {
		log.Fatal(err)
	}
	return zblob
}

func (m SnippetTable) GetByCid(cid string) *zblob.Zblob {
	row := m.db.QueryRow("SELECT * FROM pflow_snippets WHERE ipfs_cid = ?", cid)
	zblob := new(zblob.Zblob)
	err := row.Scan(&zblob.ID, &zblob.IpfsCid, &zblob.Base64Zipped, &zblob.Title, &zblob.Description, &zblob.Keywords, &zblob.Referer, &zblob.CreatedAt)
	if err != nil {
		return EmptySnippet
	}
	return zblob
}

func (m SnippetTable) GetMaxId() int64 {
	row := m.db.QueryRow("SELECT MAX(id) FROM pflow_snippets")
	var maxId int64
	err := row.Scan(&maxId)
	if err != nil {
		log.Fatal(err)
	}
	return maxId
}

func (m SnippetTable) Create(ipfsCid, base64Zipped, title, description, keywords, referrer string) (int64, error) {
	stmt, err := m.db.Prepare("INSERT INTO pflow_snippets(ipfs_cid, base64_zipped, title, description, keywords, referrer) values(?,?,?,?,?,?)")
	if err != nil {
		log.Fatal(err)
	}
	res, err := stmt.Exec(ipfsCid, base64Zipped, title, description, keywords, referrer)
	if err != nil {
		if err.Error() == "UNIQUE constraint failed: pflow_snippets.ipfs_cid" {
			return m.GetByCid(ipfsCid).ID, nil
		}
	}
	id, err := res.LastInsertId()
	if err != nil {
		log.Fatal(err)
	}
	return id, nil
}
