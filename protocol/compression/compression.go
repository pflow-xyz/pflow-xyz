package compression

import (
	"bytes"
	"encoding/base64"
	"github.com/andybalholm/brotli"
	"io/ioutil"
	"net/url"
	"strings"
)

func DecompressBrotliDecode(base64String string) (sourceJson string, ok bool) {
	data, err := base64.StdEncoding.DecodeString(base64String)
	if err != nil {
		return "", false
	}
	reader := bytes.NewReader(data)
	br := brotli.NewReader(reader)
	decompressedData, err := ioutil.ReadAll(br)
	if err != nil {
		return "", false
	}
	return string(decompressedData), true
}

func DecompressEncodedUrl(urlString string) (sourceJson string, ok bool) {
	parsedUrl, err := url.Parse(urlString)
	if err != nil {
		return "", false
	}
	base64String := parsedUrl.Query().Get("z")
	if base64String == "" {
		return "", false
	}
	return DecompressBrotliDecode(strings.ReplaceAll(base64String, " ", "+"))
}

func CompressBrotliEncode(fileData []byte) (base64String string, ok bool) {
	var buffer bytes.Buffer
	bw := brotli.NewWriter(&buffer)
	_, err := bw.Write(fileData)
	if err != nil {
		return "", false
	}
	err = bw.Close()
	if err != nil {
		return "", false
	}
	return base64.StdEncoding.EncodeToString(buffer.Bytes()), true
}
