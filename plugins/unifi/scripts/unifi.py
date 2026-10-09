#!/usr/bin/env python3
"""Read-only UniFi Network client built on the official APIs.

Talks to the Network Integration API through the Site Manager Connector
(https://api.ui.com/v1/connector/consoles/<console>/proxy/network/integration/v1).
It only ever sends GET requests: there is no write code in this file.

Usage: unifi.py <resource> [id] [--site SITE] [--json]
       unifi.py get <path>          # any GET path under .../integration/v1
       unifi.py --help

API key (create at https://unifi.ui.com/settings/api-keys), first match wins:
  $UNIFI_API_KEY
  the file $UNIFI_API_KEY_FILE (default ~/.config/unifi-skill/api-key, mode 600)
Optional: UNIFI_CONSOLE_ID (default: your only console), UNIFI_API_BASE.
"""
import argparse
import json
import os
import ssl
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = os.environ.get("UNIFI_API_BASE", "https://api.ui.com").rstrip("/")

# name -> (path template, takes an id as last segment)
RESOURCES = {
    "info": "info",
    "sites": "sites",
    "pending-devices": "pending-devices",
    "devices": "sites/{site}/devices",
    "device-stats": "sites/{site}/devices/{id}/statistics/latest",
    "clients": "sites/{site}/clients",
    "networks": "sites/{site}/networks",
    "wifi": "sites/{site}/wifi/broadcasts",
    "firewall-policies": "sites/{site}/firewall/policies",
    "firewall-zones": "sites/{site}/firewall/zones",
    "acl-rules": "sites/{site}/acl-rules",
    "dns": "sites/{site}/dns/policies",
    "wans": "sites/{site}/wans",
    "vpn-servers": "sites/{site}/vpn/servers",
    "vpn-tunnels": "sites/{site}/vpn/site-to-site-tunnels",
    "traffic-lists": "sites/{site}/traffic-matching-lists",
}


def api_key() -> str:
    key = os.environ.get("UNIFI_API_KEY")
    if key:
        return key.strip()
    path = Path(os.environ.get("UNIFI_API_KEY_FILE", "~/.config/unifi-skill/api-key")).expanduser()
    if path.is_file():
        if os.name != "nt" and path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            sys.exit(f"{path} is readable by others; run: chmod 600 {path}")
        return path.read_text().strip()
    sys.exit("No API key: set UNIFI_API_KEY or put it in ~/.config/unifi-skill/api-key "
             "(create one at https://unifi.ui.com/settings/api-keys)")


def get(url: str, key: str):
    req = urllib.request.Request(url, headers={"X-API-KEY": key, "Accept": "application/json"},
                                 method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} for {url.split('?')[0]}: {e.read().decode()[:500]}")
    except urllib.error.URLError as e:
        hint = (" (Python has no CA certificates: on macOS run 'Install Certificates.command', "
                "or install certifi and set SSL_CERT_FILE)"
                if isinstance(e.reason, ssl.SSLCertVerificationError) else "")
        sys.exit(f"Connection failed: {e.reason}{hint}")


def get_all(url: str, key: str):
    """Follow offset/limit pagination and return the concatenated `data` list."""
    sep = "&" if "?" in url else "?"
    items, offset = [], 0
    while True:
        page = get(f"{url}{sep}limit=200&offset={offset}", key)
        if not (isinstance(page, dict) and isinstance(page.get("data"), list)):
            return page  # not a paginated list
        items += page["data"]
        offset += len(page["data"])
        if not page["data"] or offset >= page.get("totalCount", offset):
            return items


def console_id(key: str) -> str:
    if os.environ.get("UNIFI_CONSOLE_ID"):
        return os.environ["UNIFI_CONSOLE_ID"]
    consoles = [h for h in get(f"{BASE}/v1/hosts", key)["data"] if h.get("type") == "console"]
    if len(consoles) != 1:
        sys.exit(f"{len(consoles)} consoles found; set UNIFI_CONSOLE_ID to one of: "
                 + ", ".join(h["id"] for h in consoles))
    return consoles[0]["id"]


def main() -> None:
    p = argparse.ArgumentParser(description="Read-only UniFi Network client",
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog="resources: " + ", ".join(sorted(RESOURCES)))
    p.add_argument("resource", help="a resource name (see below) or 'get'")
    p.add_argument("arg", nargs="?", help="id for device-stats, or the path for 'get'")
    p.add_argument("--site", help="site id (default: your only site)")
    p.add_argument("--json", action="store_true", help="compact JSON output")
    a = p.parse_args()

    if a.resource == "get" and (not a.arg or "://" in a.arg or a.arg.startswith("//")):
        p.error("get needs a path like /sites, not a URL")
    key = api_key()
    root = f"{BASE}/v1/connector/consoles/{urllib.parse.quote(console_id(key), safe='')}" \
           "/proxy/network/integration/v1"

    if a.resource == "get":
        path = a.arg.lstrip("/")
    elif a.resource in RESOURCES:
        path = RESOURCES[a.resource]
        if "{site}" in path:
            site = a.site
            if not site:
                sites = get_all(f"{root}/sites", key)
                if len(sites) != 1:
                    sys.exit("Several sites: pass --site with one of: "
                             + ", ".join(f"{s['id']} ({s['name']})" for s in sites))
                site = sites[0]["id"]
            path = path.replace("{site}", urllib.parse.quote(site, safe=""))
        if "{id}" in path:
            if not a.arg:
                p.error(f"{a.resource} needs an id")
            path = path.replace("{id}", urllib.parse.quote(a.arg, safe=""))
    else:
        p.error(f"unknown resource {a.resource!r}")

    data = get_all(f"{root}/{path}", key)
    print(json.dumps(data) if a.json else json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
