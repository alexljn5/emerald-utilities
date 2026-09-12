mkcert -install

mkcert \
-key-file src/oauth/certs/localhost-key.pem \
-cert-file src/oauth/certs/localhost.pem \
localhost 127.0.0.1 ::1