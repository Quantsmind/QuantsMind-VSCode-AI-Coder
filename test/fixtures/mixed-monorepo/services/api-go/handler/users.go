package handler

import "net/http"

func ListUsers(w http.ResponseWriter, r *http.Request) {
	_, _ = w.Write([]byte("[]"))
}