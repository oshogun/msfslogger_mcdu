"""Compile the actual portable Rust modules without Tauri/WebView libraries.

Usage: python3 windows-client/src-tauri/tools/check-core.py
Uses the installed cargo and a temporary crate; no toolchain installation.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import tomllib

shell = Path(__file__).resolve().parents[1]
manifest = tomllib.loads((shell / 'Cargo.toml').read_text())
with tempfile.TemporaryDirectory(prefix='msfslogger-core-check-') as directory:
    scratch = Path(directory)
    scratch.joinpath('Cargo.toml').write_text(
        '[package]\nname="msfslogger-core-check"\nversion="0.1.0"\nedition="2021"\n'
        '[lib]\npath="lib.rs"\n[dependencies]\nserde_json=' +
        json.dumps(manifest['dependencies']['serde_json']) + '\n')
    scratch.joinpath('lib.rs').write_text('\n'.join(
        '#[path = ' + json.dumps(str(shell / 'src' / (name + '.rs'))) + ']\npub mod ' + name + ';'
        for name in ['config', 'framing', 'protocol', 'restart', 'supervisor']) + '\n')
    env = dict(os.environ)
    env.setdefault('CARGO_TARGET_DIR', str(scratch / 'target'))
    raise SystemExit(subprocess.call(['cargo', 'test', '--manifest-path', str(scratch / 'Cargo.toml')], env=env))
