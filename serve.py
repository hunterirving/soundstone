#!/usr/bin/env python3
"""
Serve soundstone over HTTPS so that devices on your local network can install
it as a PWA without a public web host.

This script uses mkcert to make a certificate for this computer's address on
the local network. A device does not trust that certificate until it trusts
mkcert's root certificate authority (CA), so this script prints two QR codes:

	1. an HTTP link that gives the device the mkcert root CA certificate.
	   This is the public certificate, not the private key.
	2. an HTTPS link to soundstone itself.

Both servers stop together on Ctrl+C.

Without mkcert or a network connection, it serves plain HTTP on this computer
only. That is enough to use soundstone here, but not to install it elsewhere.

After scanning the first QR code, install and trust the CA on the device:
	iOS:     Settings → General → VPN & Device Management → install the profile,
	         then Settings → General → About → Certificate Trust Settings →
	         enable full trust
	Android: open the downloaded file and follow the prompt to install it as a
	         CA certificate
"""

import http.server
import socket
import socketserver
import ssl
import subprocess
import sys
import threading
from pathlib import Path
from shutil import which

HTTP_PORT = 8000       # preferred; falls back to the next free port
CERT_HTTP_PORT = 8001  # preferred; falls back to the next free port
HTTPS_PORT = 8443      # preferred; falls back to the next free port
SCRIPT_DIR = Path(__file__).parent.absolute()
DATA_DIR = Path.home() / ".soundstone"
VENV_DIR = DATA_DIR / "venv"
CERT_FILE = DATA_DIR / "https_certs" / "cert.pem"
KEY_FILE = DATA_DIR / "https_certs" / "key.pem"

# The HTTPS server mounts the app here, so that it does not share an install
# with another app served from the same address and port.
BASE_PATH = "/soundstone/"

# Path the device fetches the root CA from. Anything else over HTTP is a 404.
CA_DOWNLOAD_PATH = "/rootCA.pem"


def run_in_venv():
	"""Re-run this script in a private venv that has the qrcode package.
	If the venv or the package cannot be set up, the script still runs and
	prints URLs without QR codes."""
	python_path = VENV_DIR / ("Scripts" if sys.platform == "win32" else "bin") / "python"
	if not python_path.exists():
		print("Creating a Python environment for QR codes...")
		subprocess.call([sys.executable, "-m", "venv", str(VENV_DIR)])
	if python_path.exists():
		has_qrcode = subprocess.run([str(python_path), "-c", "import qrcode"], capture_output=True)
		if has_qrcode.returncode != 0:
			subprocess.call([str(python_path), "-m", "pip", "install", "-q", "qrcode"])
	else:
		python_path = Path(sys.executable)
	try:
		subprocess.check_call([str(python_path), __file__, "--in-venv"])
	except (KeyboardInterrupt, subprocess.CalledProcessError):
		pass
	sys.exit(0)


def get_local_ip():
	"""Return the address other devices on the network can reach this
	computer at, or None if there is no network."""
	try:
		s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
		# Asks which local address would route to a reserved documentation
		# address (RFC 5737).
		s.connect(("192.0.2.1", 80))
		local_ip = s.getsockname()[0]
		s.close()
		return local_ip
	except OSError:
		return None


def find_available_port(start_port, max_attempts=20):
	"""Return the first port at or after start_port that can be bound.
	SO_REUSEADDR stops a socket left in TIME_WAIT by an earlier run from
	blocking the port."""
	for port in range(start_port, start_port + max_attempts):
		s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
		s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
		try:
			s.bind(("", port))
			return port
		except OSError:
			continue
		finally:
			s.close()
	sys.exit(f"Error: no free port near {start_port}.")


def print_qr_code(url, caption):
	"""Print a QR code made of block characters, two rows of the code per line."""
	try:
		import qrcode
	except ImportError:
		print(f"\n{caption}\n  (QR code unavailable; open this URL by hand)")
		return
	qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=1, border=1)
	qr.add_data(url)
	qr.make(fit=True)
	matrix = qr.get_matrix()

	print(f"\n{caption}\n")
	for y in range(0, len(matrix), 2):
		line = " "
		for x in range(len(matrix[y])):
			top = matrix[y][x]
			bottom = matrix[y + 1][x] if y + 1 < len(matrix) else False
			line += "█" if top and bottom else "▀" if top else "▄" if bottom else " "
		print(line)


def ca_root_file():
	"""Path to mkcert's root CA certificate."""
	caroot = subprocess.run(["mkcert", "-CAROOT"], capture_output=True, text=True).stdout.strip()
	return Path(caroot) / "rootCA.pem"


def ensure_ca_installed():
	"""Make sure mkcert's local CA exists and this computer trusts it.
	mkcert may ask for your password to write to the system trust store."""
	if not ca_root_file().exists():
		print("Setting up the mkcert local CA (you may be asked for your password)...")
		subprocess.check_call(["mkcert", "-install"])


def ensure_leaf_cert(local_ip):
	"""Make a certificate and key for this computer's network address and for
	localhost, unless there is already one for the same address."""
	CERT_FILE.parent.mkdir(parents=True, exist_ok=True)
	if CERT_FILE.exists() and KEY_FILE.exists():
		try:
			names = ssl._ssl._test_decode_cert(str(CERT_FILE)).get("subjectAltName", ())
		except (AttributeError, OSError):
			names = ()
		if ("IP Address", local_ip) in names:
			return
	print(f"Making a certificate for {local_ip}...")
	subprocess.check_call([
		"mkcert",
		"-cert-file", str(CERT_FILE),
		"-key-file", str(KEY_FILE),
		local_ip, "localhost", "127.0.0.1",
	])


def start_ca_server(local_ip):
	"""Start a plain HTTP server that hands out the mkcert root CA certificate,
	and return it running. The certificate is public, so it is served to any
	device for as long as the script runs. The caller shuts the server down."""
	ca_bytes = ca_root_file().read_bytes()

	class CAHandler(http.server.BaseHTTPRequestHandler):
		def log_message(self, *args):
			pass

		def do_GET(self):
			if self.path in ("/", "/index.html"):
				self.send_response(302)
				self.send_header("Location", CA_DOWNLOAD_PATH)
				self.end_headers()
				return
			if self.path != CA_DOWNLOAD_PATH:
				self.send_error(404)
				return
			# This content type makes iOS offer to install the file as a CA profile.
			self.send_response(200)
			self.send_header("Content-Type", "application/x-x509-ca-cert")
			self.send_header("Content-Length", str(len(ca_bytes)))
			self.send_header("Content-Disposition", 'attachment; filename="rootCA.pem"')
			self.end_headers()
			try:
				self.wfile.write(ca_bytes)
			except (BrokenPipeError, ConnectionResetError):
				return

	port = find_available_port(CERT_HTTP_PORT)
	http.server.HTTPServer.allow_reuse_address = True
	httpd = http.server.HTTPServer(("", port), CAHandler)
	threading.Thread(target=httpd.serve_forever, daemon=True).start()

	cert_url = f"http://{local_ip}:{port}{CA_DOWNLOAD_PATH}"
	print("=" * 69)
	print("STEP 1: install + trust the local CA on each device (first time only)")
	print("=" * 69)
	print_qr_code(cert_url, "Scan to download the root certificate:")
	print(f"  {cert_url}")
	print("\nOn iOS, after downloading:")
	print("  • Settings → General → VPN & Device Management → install the profile")
	print("  • Settings → General → About → Certificate Trust Settings →")
	print("    toggle ON full trust for the mkcert CA")
	print("\nOn Android, after downloading:")
	print("  • open the downloaded file, or Settings → Security → Encryption &")
	print("    credentials → Install a certificate → CA certificate, then confirm")
	print("\n(skip this step on a device that already trusts the CA from an earlier run)")
	return httpd


class ThreadingServer(socketserver.ThreadingTCPServer):
	daemon_threads = True
	allow_reuse_address = True


class TLSThreadingServer(ThreadingServer):
	"""Threading server that does the TLS handshake in the worker thread, so
	that one slow or abandoned handshake does not block other connections."""

	def __init__(self, server_address, handler_cls, ssl_context):
		self.ssl_context = ssl_context
		super().__init__(server_address, handler_cls)

	def process_request_thread(self, request, client_address):
		try:
			request.settimeout(20)
			request = self.ssl_context.wrap_socket(request, server_side=True)
			request.settimeout(None)
		except (ssl.SSLError, OSError):
			# A device that does not trust the CA, a probe, or a client that left.
			self.shutdown_request(request)
			return
		super().process_request_thread(request, client_address)


def make_handler(base_path):
	"""Return a handler that serves SCRIPT_DIR mounted under base_path."""
	class Handler(http.server.SimpleHTTPRequestHandler):
		def __init__(self, *args, **kwargs):
			super().__init__(*args, directory=str(SCRIPT_DIR), **kwargs)

		def end_headers(self):
			# Makes browsers check for a newer file on every load.
			self.send_header("Cache-Control", "no-cache")
			super().end_headers()

		def log_message(self, *args):
			pass

		def handle(self):
			try:
				super().handle()
			except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
				pass

		def translate_path(self, path):
			if base_path != "/" and path.startswith(base_path):
				path = "/" + path[len(base_path):]
			return super().translate_path(path)

		def do_GET(self):
			# Sends a visit to the bare address into the app.
			if base_path != "/" and self.path in ("/", "/index.html"):
				self.send_response(302)
				self.send_header("Location", base_path)
				self.send_header("Content-Length", "0")
				self.end_headers()
				return
			return super().do_GET()

	return Handler


def serve_http():
	"""Serve over plain HTTP to this computer only. Runs until Ctrl+C."""
	port = find_available_port(HTTP_PORT)
	with ThreadingServer(("127.0.0.1", port), make_handler("/")) as httpd:
		print(f"\nServing over plain HTTP at http://localhost:{port}")
		print("Other devices can't install soundstone from here, because that needs HTTPS.")
		print("\nPress Ctrl+C to stop the server")
		try:
			httpd.serve_forever()
		except KeyboardInterrupt:
			print("\n\nShutting down...")


def serve_https(local_ip, ca_httpd):
	"""Serve over HTTPS under BASE_PATH. Runs until Ctrl+C, then also shuts
	down the CA server."""
	ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
	ctx.load_cert_chain(certfile=str(CERT_FILE), keyfile=str(KEY_FILE))
	port = find_available_port(HTTPS_PORT)

	with TLSThreadingServer(("", port), make_handler(BASE_PATH), ctx) as httpd:
		https_url = f"https://{local_ip}:{port}{BASE_PATH}"
		print("\n" + "=" * 60)
		print("STEP 2: install soundstone (once the device trusts the CA)")
		print("=" * 60)
		print_qr_code(https_url, "Scan to open soundstone over HTTPS:")
		print(f"  {https_url}")
		print("\nThen install it: Share → Add to Home Screen on iOS, or the")
		print("browser menu → Install app on Android.")
		print(f"\nOn this computer, open https://localhost:{port}{BASE_PATH}")
		print("\nPress Ctrl+C to stop the servers")
		try:
			httpd.serve_forever()
		except KeyboardInterrupt:
			print("\n\nShutting down...")
		finally:
			ca_httpd.shutdown()
			ca_httpd.server_close()


def start():
	local_ip = get_local_ip()
	if not local_ip:
		print("Couldn't find this computer's address on a local network.")
		serve_http()
		return
	if which("mkcert") is None:
		print("mkcert isn't installed, so HTTPS isn't available.")
		print("Install it from https://github.com/FiloSottile/mkcert and run serve.py again.")
		serve_http()
		return

	ensure_ca_installed()
	ensure_leaf_cert(local_ip)
	serve_https(local_ip, start_ca_server(local_ip))


if __name__ == "__main__":
	if "--in-venv" in sys.argv:
		start()
	else:
		run_in_venv()
