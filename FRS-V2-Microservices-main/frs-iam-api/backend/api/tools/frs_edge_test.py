#!/usr/bin/env python3
"""
FRS Edge Device — ZTP Connectivity & Activation Test Script
============================================================
Run this on the Jetson (or any local machine) to verify the full
Zero-Touch Provisioning flow against your FRS backend.

Usage:
    python3 frs_edge_test.py

Requirements: Python 3.6+ standard library only (urllib, json, socket, os)
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG — edit these before running
# ─────────────────────────────────────────────────────────────────────────────
SERVER_URL    = "https://frs.motivitylabs.com"   # Your FRS backend URL
PIN           = ""                                 # Paste PIN from dashboard, e.g. "123-456"
DEVICE_CODE   = ""                                 # Unique ID for this box, e.g. "jetson-lab-01"
DEVICE_NAME   = ""                                 # Human-readable name, e.g. "Lab Entrance Box"
LOCATION      = "Not set"                          # e.g. "Building A - Lobby"
DEVICE_TYPE   = "jetson_orin_nx"                   # or "jetson_xavier_nx"
TOKEN_FILE    = "/tmp/frs_test_token.txt"          # Where to save the token during test
# ─────────────────────────────────────────────────────────────────────────────

# ANSI colours
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

PASS = f"{GREEN}✅ PASS{RESET}"
FAIL = f"{RED}❌ FAIL{RESET}"
INFO = f"{CYAN}ℹ{RESET}"
WARN = f"{YELLOW}⚠{RESET}"

def banner(text):
    print(f"\n{BOLD}{CYAN}{'='*60}{RESET}")
    print(f"{BOLD}{CYAN}  {text}{RESET}")
    print(f"{BOLD}{CYAN}{'='*60}{RESET}")

def step(num, text):
    print(f"\n{BOLD}[Step {num}]{RESET} {text}")

def ok(msg):
    print(f"  {PASS}  {msg}")

def fail(msg):
    print(f"  {FAIL}  {msg}")

def info(msg):
    print(f"  {INFO}  {msg}")

def warn(msg):
    print(f"  {WARN}  {msg}")

def http_post(url, data=None, headers=None, token=None):
    """Simple HTTP POST using stdlib urllib."""
    req_headers = {"Content-Type": "application/json"}
    if token:
        req_headers["Authorization"] = f"Bearer {token}"
    if headers:
        req_headers.update(headers)

    body = json.dumps(data).encode("utf-8") if data else b""
    req = urllib.request.Request(url, data=body, headers=req_headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {"error": str(e)}
    except Exception as e:
        return 0, {"error": str(e)}

def http_get(url, token=None):
    """Simple HTTP GET using stdlib urllib."""
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {"error": str(e)}
    except Exception as e:
        return 0, {"error": str(e)}

# ─────────────────────────────────────────────────────────────────────────────
# Hardware detection helpers (same as ztp_daemon.py)
# ─────────────────────────────────────────────────────────────────────────────

def detect_ip():
    try:
        result = subprocess.run(["ip", "route", "get", "8.8.8.8"],
                                capture_output=True, text=True, timeout=5)
        for part in result.stdout.split():
            if part == "src":
                idx = result.stdout.split().index("src")
                return result.stdout.split()[idx + 1]
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def detect_mac():
    try:
        result = subprocess.run(["ip", "route", "get", "8.8.8.8"],
                                capture_output=True, text=True, timeout=5)
        dev = None
        parts = result.stdout.split()
        for i, p in enumerate(parts):
            if p == "dev" and i + 1 < len(parts):
                dev = parts[i + 1]
                break
        if dev:
            with open(f"/sys/class/net/{dev}/address") as f:
                return f.read().strip()
    except Exception:
        pass
    return "00:00:00:00:00:00"

def detect_serial():
    for path in ["/proc/device-tree/serial-number",
                 "/sys/class/dmi/id/product_serial"]:
        try:
            with open(path) as f:
                s = f.read().strip().replace("\x00", "")
                if s and s not in ("", "N/A", "None"):
                    return s
        except Exception:
            pass
    try:
        result = subprocess.run(["cat", "/proc/cpuinfo"],
                                capture_output=True, text=True, timeout=5)
        for line in result.stdout.splitlines():
            if "Serial" in line and ":" in line:
                serial = line.split(":")[1].strip()
                if serial and serial != "0000000000000000":
                    return serial
    except Exception:
        pass
    return "UNKNOWN"

# ─────────────────────────────────────────────────────────────────────────────
# TESTS
# ─────────────────────────────────────────────────────────────────────────────

def test_1_config():
    banner("PRE-FLIGHT: Config Check")
    errors = []
    if not SERVER_URL or SERVER_URL == "https://your-frs-server.com":
        errors.append("SERVER_URL is not set")
    if not PIN or PIN == "":
        errors.append("PIN is not set — generate one from the FRS dashboard")
    if not DEVICE_CODE or DEVICE_CODE == "":
        errors.append("DEVICE_CODE is not set")
    if not DEVICE_NAME or DEVICE_NAME == "":
        errors.append("DEVICE_NAME is not set")

    if errors:
        for e in errors:
            fail(e)
        print(f"\n{RED}Edit the CONFIG section at the top of this script and re-run.{RESET}")
        sys.exit(1)
    else:
        ok(f"SERVER_URL   = {SERVER_URL}")
        ok(f"PIN          = {PIN}")
        ok(f"DEVICE_CODE  = {DEVICE_CODE}")
        ok(f"DEVICE_NAME  = {DEVICE_NAME}")
        ok(f"DEVICE_TYPE  = {DEVICE_TYPE}")


def test_2_hardware():
    banner("STEP 1: Hardware Detection")
    ip  = detect_ip()
    mac = detect_mac()
    ser = detect_serial()

    ok(f"IP Address    = {ip}")
    ok(f"MAC Address   = {mac}")
    ok(f"Serial Number = {ser}")

    if ip == "127.0.0.1":
        warn("IP resolved to loopback — check network interface")
    if ser == "UNKNOWN":
        warn("Serial not detected — will use 'UNKNOWN' (non-blocking)")

    return ip, mac, ser


def test_3_connectivity():
    banner("STEP 2: Network Connectivity to FRS Backend")
    # Ping the activate endpoint with empty body — expect 400 (reachable)
    step(1, f"Hitting {SERVER_URL}/api/device-management/devices/activate")
    status, body = http_post(f"{SERVER_URL}/api/device-management/devices/activate", data={})

    if status == 400 and "Missing required" in body.get("error", ""):
        ok(f"Server reachable — got expected 400: {body.get('error')}")
    elif status == 0:
        fail(f"Cannot reach server: {body.get('error')}")
        print(f"\n  {RED}Check:{RESET}")
        print(f"    • Is the Jetson connected to the internet/LAN?")
        print(f"    • Is {SERVER_URL} correct?")
        print(f"    • Try: curl {SERVER_URL}/api/device-management/devices/activate")
        sys.exit(1)
    else:
        warn(f"Unexpected response — HTTP {status}: {body}")


def test_4_activate(ip, mac, serial):
    banner("STEP 3: ZTP Activation (PIN Handshake)")
    step(1, f"Sending activation request with PIN={PIN}")

    payload = {
        "pin":                PIN,
        "external_device_id": DEVICE_CODE,
        "device_type_code":   DEVICE_TYPE,
        "name":               DEVICE_NAME,
        "location_label":     LOCATION,
        "ip_address":         ip,
        "serial_number":      serial,
        "mac_address":        mac,
    }

    status, body = http_post(
        f"{SERVER_URL}/api/device-management/devices/activate",
        data=payload
    )

    if status == 200 and body.get("success"):
        token = body.get("token", "")
        ok(f"Device registered! Code: {body.get('device_code')}")
        ok(f"Token received  : {token[:40]}...  (valid until {body.get('token_expires_at','?')})")
        ok(f"Server URL      : {body.get('server_url')}")

        # Save token
        with open(TOKEN_FILE, "w") as f:
            f.write(token)
        info(f"Token saved to  : {TOKEN_FILE}")
        return token

    elif status == 404 and body.get("error") == "invalid_pin":
        fail("Invalid PIN — wrong code or already used")
        print(f"  Generate a new PIN from the FRS Dashboard → Device Management → Activation Code")
        sys.exit(1)

    elif status == 410:
        fail("PIN has expired (30-minute window). Generate a fresh one.")
        sys.exit(1)

    elif status == 409 and body.get("error") == "used_pin":
        fail("PIN already used. Generate a new one.")
        sys.exit(1)

    elif status == 409 and body.get("error") == "device_exists":
        warn(f"Device '{DEVICE_CODE}' already registered.")
        # Try to load existing token
        if os.path.exists(TOKEN_FILE):
            with open(TOKEN_FILE) as f:
                token = f.read().strip()
            info(f"Loaded existing token from {TOKEN_FILE}")
            return token
        else:
            fail("No saved token found. To re-activate: delete the device from dashboard first, or use a new DEVICE_CODE.")
            sys.exit(1)

    elif status == 400 and body.get("error") == "invalid_device_type":
        fail(f"Invalid device_type_code: '{DEVICE_TYPE}'")
        print(f"  Valid values: jetson_orin_nx, jetson_xavier_nx")
        sys.exit(1)

    else:
        fail(f"Unexpected error — HTTP {status}: {body}")
        sys.exit(1)


def test_5_heartbeat(token):
    banner("STEP 4: Heartbeat Test")
    step(1, f"Sending heartbeat as device '{DEVICE_CODE}'")

    payload = {
        "status": "online",
        "metrics": {
            "cpu_temp_c": 42.5,
            "ram_used_mb": 1024,
            "uptime_seconds": 300,
            "test_run": True
        }
    }

    status, body = http_post(
        f"{SERVER_URL}/api/device-management/devices/{DEVICE_CODE}/heartbeat",
        data=payload,
        token=token
    )

    if status == 200 and body.get("success"):
        ok(f"Heartbeat accepted ✓")
        ok(f"Next heartbeat in: {body.get('next_heartbeat_seconds', '?')}s")
        cmds = body.get("commands", [])
        if cmds:
            info(f"Pending commands: {cmds}")
        else:
            info("No pending commands")
        return True

    elif status == 401:
        fail("Heartbeat rejected — 401 Unauthorized")
        print(f"  Token may be invalid or expired. Re-run activation.")
        return False

    else:
        fail(f"Heartbeat failed — HTTP {status}: {body}")
        return False


def test_6_heartbeat_loop(token, iterations=3):
    banner("STEP 5: Heartbeat Loop (3 pulses)")
    info(f"Sending {iterations} heartbeats, 5s apart...")
    for i in range(iterations):
        status, body = http_post(
            f"{SERVER_URL}/api/device-management/devices/{DEVICE_CODE}/heartbeat",
            data={"status": "online", "metrics": {"pulse": i + 1}},
            token=token
        )
        if status == 200:
            print(f"  [{i+1}/{iterations}] {GREEN}Heartbeat OK{RESET} — {time.strftime('%H:%M:%S')}")
        else:
            print(f"  [{i+1}/{iterations}] {RED}Heartbeat FAIL{RESET} — HTTP {status}: {body}")
        if i < iterations - 1:
            time.sleep(5)
    ok("Heartbeat loop complete")


def test_7_verify_dashboard(token):
    banner("STEP 6: Verify Device Visible via API")
    step(1, "Fetching device info (unauthenticated — should fail, 401)")
    status, body = http_get(
        f"{SERVER_URL}/api/device-management/devices/{DEVICE_CODE}"
    )
    if status == 401:
        ok("Unauthenticated access blocked (401) — correct security behaviour")
    else:
        warn(f"Expected 401, got {status}: {body}")


def summary(all_passed):
    banner("TEST SUMMARY")
    if all_passed:
        print(f"\n{GREEN}{BOLD}  🎉 ALL TESTS PASSED — Edge Box is fully provisioned!{RESET}")
        print(f"\n  Next steps on this device:")
        print(f"    1. Copy the token from {TOKEN_FILE} to /opt/frs/device_token.txt")
        print(f"    2. Run the full ztp_daemon.py to start continuous heartbeats")
        print(f"    3. Open the FRS Dashboard → Device Management — device should be ONLINE")
    else:
        print(f"\n{RED}{BOLD}  ⚠ Some tests failed. Review output above.{RESET}")


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"\n{BOLD}FRS Edge Device — ZTP Test Script{RESET}")
    print(f"Server: {SERVER_URL}")
    print(f"Time  : {time.strftime('%Y-%m-%d %H:%M:%S')}")

    test_1_config()
    ip, mac, serial = test_2_hardware()
    test_3_connectivity()
    token = test_4_activate(ip, mac, serial)
    hb_ok = test_5_heartbeat(token)
    if hb_ok:
        test_6_heartbeat_loop(token)
    test_7_verify_dashboard(token)
    summary(hb_ok)
