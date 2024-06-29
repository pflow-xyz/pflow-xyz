package compression

import (
	"testing"
)

func TestCompressBrotliEncodeAndDecode(t *testing.T) {
	fileData := "Test Compress Brotli Encode"
	base64String, ok := CompressBrotliEncode([]byte(fileData))
	if !ok {
		t.Fatalf("failed to compress")
	}
	t.Logf("base64String: %s", base64String)
	sourceJson, ok := DecompressBrotliDecode(base64String)
	if !ok {
		t.Fatalf("failed to decompress")
	}
	if sourceJson != fileData {
		t.Fatalf("mismatch %v", sourceJson)
	}
}

func TestDecompressEncodedUrl(t *testing.T) {
	rawData := "GxUBIBwHdqMPWUayBmvB036CyG2p/i4T/vkhUIqhOINzBItzjIAjQRT6UodFYb3lf/s+tUpixqYotpvtm6rosihFrSj0hinJ5yEzylwRkOHP3/C10Z+9DY4wrECyVuOuK6yIowpW+wANmGBbDfiT25M8ymZktaqaaJI4OGKn72O+5sEtRzooqYttsJIJXHe9+n0VHHo2"
	urlString := "https://pflow-dev.github.io/pflow-js/p/?z=" + rawData
	sourceJson, ok := DecompressEncodedUrl(urlString)
	if !ok {
		t.Fatalf("failed to decompress")
	}
	t.Logf("%s", urlString)
	t.Logf("sourceJson: %s", sourceJson)
}
