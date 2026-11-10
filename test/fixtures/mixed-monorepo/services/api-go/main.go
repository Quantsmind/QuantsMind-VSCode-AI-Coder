package main

import (
	"net/http"

	"github.com/demo/api-go/handler"
)

func main() {
	http.HandleFunc("/users", handler.ListUsers)
	_ = http.ListenAndServe(":8080", nil)
}
