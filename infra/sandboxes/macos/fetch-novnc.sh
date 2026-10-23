#!/usr/bin/env bash
set -euo pipefail
VERSION=1.3.0
SHA256=ee8f91514c9ce9f4054d132f5f97167ee87d9faa6630379267e569d789290336
TARGET="${1:?usage: fetch-novnc.sh TARGET_DIR}"
archive="$(mktemp)"
staging="${TARGET}.partial"
trap 'rm -rf "${archive}" "${staging}"' EXIT
curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${VERSION}.tar.gz" -o "${archive}"
echo "${SHA256}  ${archive}" | shasum -a 256 -c -
rm -rf "${staging}"
mkdir -p "${staging}"
tar -xzf "${archive}" -C "${staging}" --strip-components=1 \
  "noVNC-${VERSION}/core" "noVNC-${VERSION}/vendor" "noVNC-${VERSION}/LICENSE.txt"
rm -rf "${TARGET}"
mv "${staging}" "${TARGET}"
echo "noVNC ${VERSION} is in ${TARGET}"
