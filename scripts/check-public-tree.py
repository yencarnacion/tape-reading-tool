#!/usr/bin/env python3
"""Check publishable Git files without printing credentials or matched content."""
import argparse
import ipaddress
from pathlib import Path
import re
import subprocess
import sys


def findings(name, data, denied=()):
    issues = []
    path = Path(name)
    if path.name.startswith('.env') and path.name != '.env.example':
        issues.append('environment file')
    if path.suffix.lower() in {'.db', '.sqlite', '.sqlite3', '.pem', '.key'} or name.startswith(('data/', 'local/', 'exports/')):
        issues.append('local data or key artifact')
    if b'\0' in data:
        return issues  # Existing images are reviewed visually, not scanned as text.
    content = data.decode('utf-8', errors='replace')
    checks = {
        'personal absolute path': r'/(?:Users|home)/[A-Za-z][^/\s"\']+/',
        'private key material': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
        'personal chat link': r'https://chatgpt\.com/share/[A-Za-z0-9-]+',
        'credential literal': r'(?i)(?:api[_-]?key|token|password|secret)\s*[:=]\s*["\'][A-Za-z0-9+/=_-]{24,}["\']',
        'credential in URL': r'https?://[^/\s:@]+:[^/\s@]+@',
    }
    is_test = path.name.endswith(('_test.go', '-check.mjs', '-check.py'))
    for label, pattern in checks.items():
        # Auth rejection fixtures may deliberately use fake URL credentials.
        if label == 'credential in URL' and is_test:
            continue
        if re.search(pattern, content):
            issues.append(label)
    for raw in re.findall(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', content):
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if ip.is_loopback or raw == '0.0.0.0':
            continue
        if any(ip in ipaddress.ip_network(cidr) for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
            if not ((is_test or name == 'scripts/check-public-tree.py') and raw in {'10.0.0.0', '192.168.0.0', '172.16.0.0', '10.0.0.1', '192.168.0.1', '172.16.0.1'}):
                issues.append('private deployment address')
    if any(term.casefold() in content.casefold() for term in denied):
        issues.append('locally denied private reference')
    return sorted(set(issues))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', default='.')
    ap.add_argument('--deny-file', help='Optional private file of literal terms; never prints its contents')
    args = ap.parse_args()
    root = Path(args.root).resolve()
    denied = Path(args.deny_file).read_text().splitlines() if args.deny_file else []
    denied = [term for term in denied if term and not term.startswith('#')]
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).split(b'\0')
    failed, count = False, 0
    for raw in sorted(set(paths)):
        if not raw:
            continue
        name = raw.decode(); path = root / name
        if not path.is_file():
            continue
        count += 1
        issues = findings(name, path.read_bytes(), denied)
        if issues:
            failed = True
            print(f'{name}: {", ".join(issues)}')
    print(f'Public-file guard: {count} files checked; {"review required" if failed else "passed"}.')
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
