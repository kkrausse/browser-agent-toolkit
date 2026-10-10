#!/usr/bin/env bash
# TLS in front of the mock model server, for clients that do their own TLS and
# verify certificates (codex-local through the page's TCP tunnel).
#
#   :4797  https://mock-llm.test   certificate signed by the test CA made below
#   :4798  the same server with a certificate from a CA nobody is given
#
# Both speak HTTP/1.1 and HTTP/2 (ALPN) and pass WebSocket upgrades through.
#
# The CA is generated every time this container starts, constrained (critical
# name constraints) to the one name `mock-llm.test`, and its private key is
# deleted as soon as the server certificate is signed: nothing that could sign
# another certificate exists afterwards, and nothing it signed is valid for a
# real host. /tmp/mock-tls/ca.pem is the certificate to trust (mock-llm/up.sh
# copies it out to wasm-term/.state/mock-tls/ca.pem).
set -euo pipefail
D=/tmp/mock-tls
rm -rf "$D"; mkdir -p "$D"; cd "$D"

cat > ca.cnf <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = wasm-term mock-llm test CA (not for real hosts)
[v3]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign
nameConstraints = critical, permitted;DNS:mock-llm.test
subjectKeyIdentifier = hash
CNF
cat > leaf.ext <<'EXT'
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:mock-llm.test
authorityKeyIdentifier = keyid
EXT
openssl ecparam -name prime256v1 -genkey -noout -out ca.key 2>/dev/null
openssl req -x509 -new -key ca.key -sha256 -days 30 -config ca.cnf -out ca.pem
openssl ecparam -name prime256v1 -genkey -noout -out leaf.key 2>/dev/null
openssl req -new -key leaf.key -subj "/CN=mock-llm.test" -out leaf.csr
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -sha256 -days 30 -extfile leaf.ext -out leaf.pem 2>/dev/null
rm -f ca.key ca.srl leaf.csr
# The same kind of certificate from a second CA that nobody is ever given: a server whose
# certificate chain a client has no reason to trust.
cat > other.ext <<'EXT'
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:mock-llm.test, DNS:untrusted.mock-llm.test
authorityKeyIdentifier = keyid
EXT
openssl ecparam -name prime256v1 -genkey -noout -out other-ca.key 2>/dev/null
openssl req -x509 -new -key other-ca.key -sha256 -days 30 -config ca.cnf -out other-ca.pem
openssl ecparam -name prime256v1 -genkey -noout -out untrusted.key 2>/dev/null
openssl req -new -key untrusted.key -subj "/CN=untrusted.mock-llm.test" -out untrusted.csr
openssl x509 -req -in untrusted.csr -CA other-ca.pem -CAkey other-ca.key -CAcreateserial -sha256 -days 30 -extfile other.ext -out untrusted.pem 2>/dev/null
rm -f other-ca.key other-ca.pem other-ca.srl untrusted.csr

cat > nginx.conf <<'NGINX'
daemon off;
worker_processes 1;
pid /tmp/mock-tls/nginx.pid;
error_log stderr warn;
events {}
http {
  access_log off;
  client_body_temp_path /tmp/mock-tls/body;
  proxy_temp_path /tmp/mock-tls/proxy;
  fastcgi_temp_path /tmp/mock-tls/fastcgi;
  uwsgi_temp_path /tmp/mock-tls/uwsgi;
  scgi_temp_path /tmp/mock-tls/scgi;
  client_max_body_size 64m;
  map $http_upgrade $connection_upgrade { default upgrade; "" ""; }
  # Streamed as it arrives in both directions (server-sent events, long replies).
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  proxy_set_header Host $host;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  ssl_protocols TLSv1.2 TLSv1.3;
  server {
    listen 4797 ssl http2;
    ssl_certificate /tmp/mock-tls/leaf.pem;
    ssl_certificate_key /tmp/mock-tls/leaf.key;
    location / { proxy_pass http://mock:4791; }
  }
  server {
    listen 4798 ssl http2;
    ssl_certificate /tmp/mock-tls/untrusted.pem;
    ssl_certificate_key /tmp/mock-tls/untrusted.key;
    location / { proxy_pass http://mock:4791; }
  }
}
NGINX
echo "tls front: https://mock-llm.test on :4797 (test CA), :4798 (untrusted certificate)"
exec nginx -c /tmp/mock-tls/nginx.conf
