package main

import (
  "fmt"
  "strings"
  "net/http"
  "io/ioutil"
)

func main() {

  url := "https://quaint-empty-morning.ethereum-sepolia.quiknode.pro/e59287fd795cbdda825377a3b62eb7c08093419f/"
  method := "POST"

  payload := strings.NewReader(`{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}`)

  client := &http.Client {
  }
  req, err := http.NewRequest(method, url, payload)

  if err != nil {
    fmt.Println(err)
    return
  }
  req.Header.Add("Content-Type", "application/json")

  res, err := client.Do(req)
  if err != nil {
    fmt.Println(err)
    return
  }
  defer res.Body.Close()

  body, err := ioutil.ReadAll(res.Body)
  if err != nil {
    fmt.Println(err)
    return
  }
  fmt.Println(string(body))
}