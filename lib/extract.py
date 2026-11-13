#!/usr/bin/env python3
"""Isolated extractor for Android-BuildToolchain.

Usage: extract.py <kind> <archive> <destdir>
kinds: zip tar.gz tar.xz txz xz deb
Prints "PROGRESS <0-100> <note>" lines on stderr; the last line is "DONE".
Everything stays under destdir; no writes outside it.
"""
import io, os, sys, tarfile, zipfile, lzma, shutil

def prog(p, note=""):
    sys.stderr.write("PROGRESS %d %s\n" % (p, note))
    sys.stderr.flush()

def safe_path(dest, name):
    name = name.replace("\\", "/").lstrip("/")
    p = os.path.normpath(os.path.join(dest, name))
    if not p.startswith(os.path.normpath(dest) + os.sep) and p != os.path.normpath(dest):
        raise RuntimeError("unsafe path: " + name)
    return p

def extract_zip(src, dest):
    with zipfile.ZipFile(src) as z:
        items = z.infolist()
        total = max(1, len(items))
        for i, it in enumerate(items, 1):
            z.extract(it, dest)
            mode = (it.external_attr >> 16) & 0o777
            if mode:
                try: os.chmod(safe_path(dest, it.filename), mode)
                except OSError: pass
            if i % 50 == 0 or i == total:
                prog(int(i * 100 / total), it.filename[-60:])

def extract_tar(src, dest, mode="r:*"):
    with tarfile.open(src, mode) as t:
        members = t.getmembers()
        total = max(1, len(members))
        for i, m in enumerate(members, 1):
            t.extract(m, dest, set_attrs=True)
            if i % 200 == 0 or i == total:
                prog(int(i * 100 / total), m.name[-60:])

def extract_xz(src, dest):
    out = os.path.join(dest, os.path.basename(src)[:-3])
    with lzma.open(src, "rb") as fi, open(out, "wb") as fo:
        n = 0
        while True:
            b = fi.read(1 << 20)
            if not b: break
            fo.write(b); n += len(b)
            prog(min(99, n // (1 << 20)), "decompress")
    prog(100, os.path.basename(out))

def ar_members(src):
    with open(src, "rb") as f:
        if f.read(8) != b"!<arch>\n": raise RuntimeError("not a deb/ar archive")
        while True:
            hdr = f.read(60)
            if len(hdr) < 60: break
            name = hdr[0:16].decode("utf8", "replace").strip().rstrip("/")
            size = int(hdr[48:58].decode("utf8").strip() or 0)
            data = f.read(size)
            if size % 2: f.read(1)
            yield name, data

def extract_deb(src, dest):
    for name, data in ar_members(src):
        if not name.startswith("data.tar"): continue
        tmp = os.path.join(dest, ".data.tar.xz" if name.endswith(".xz") else ".data.tar")
        with open(tmp, "wb") as f: f.write(data)
        extract_tar(tmp, dest, "r:xz" if name.endswith(".xz") else "r:*")
        os.unlink(tmp)
        break

def flatten(dest):
    entries = [e for e in os.listdir(dest) if e != ".DS_Store"]
    if len(entries) == 1:
        p = os.path.join(dest, entries[0])
        if os.path.isdir(p):
            tmp = dest + ".flat"
            os.rename(p, tmp)
            for e in os.listdir(dest):
                q = os.path.join(dest, e)
                try: os.remove(q)
                except OSError: shutil.rmtree(q, ignore_errors=True)
            os.rmdir(dest)
            os.rename(tmp, dest)

def main():
    kind, src, dest = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(dest, exist_ok=True)
    prog(1, "open " + os.path.basename(src))
    if kind == "zip": extract_zip(src, dest)
    elif kind in ("tar.gz", "tgz"): extract_tar(src, dest, "r:gz")
    elif kind in ("tar.xz", "txz"): extract_tar(src, dest, "r:xz")
    elif kind == "xz": extract_xz(src, dest)
    elif kind == "deb": extract_deb(src, dest)
    else: raise SystemExit("unknown kind " + kind)
    if kind != "deb":
        flatten(dest)
    prog(100, "DONE")

if __name__ == "__main__":
    main()
