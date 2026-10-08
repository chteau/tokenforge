package httpx

import (
	"net"
	"net/http"
	"strings"
)

// ClientIP returns the best-effort client address. X-Forwarded-For is only
// honoured when trustProxy is true, because it is trivially spoofable.
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			first, _, _ := strings.Cut(fwd, ",")
			if ip := strings.TrimSpace(first); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// StatusRecorder wraps a ResponseWriter and remembers the status code and
// number of bytes written.
type StatusRecorder struct {
	http.ResponseWriter
	Status int
	Bytes  int
}

// NewStatusRecorder returns a recorder that defaults to 200 OK.
func NewStatusRecorder(w http.ResponseWriter) *StatusRecorder {
	return &StatusRecorder{ResponseWriter: w, Status: http.StatusOK}
}

// WriteHeader records the status code.
func (s *StatusRecorder) WriteHeader(code int) {
	s.Status = code
	s.ResponseWriter.WriteHeader(code)
}

// Write records the number of bytes written.
func (s *StatusRecorder) Write(b []byte) (int, error) {
	n, err := s.ResponseWriter.Write(b)
	s.Bytes += n
	return n, err
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *StatusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }
