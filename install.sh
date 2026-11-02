#!/usr/bin/env sh
# Flywheel bootstrap installer.
#
# It resolves one immutable release tag, downloads only from that tag, proves
# the archive is the published one, admits every archive entry before a single
# byte is extracted, extracts into a private directory of this account, proves
# the extracted tree again, and then hands over to the archive's own installer.
# It refuses an explicit older pin when the active build establishes its version.
# Installation and activation belong to the binary (ARCH-DISTRIBUTION-014).
set -eu

REPO="${FLYWHEEL_REPO:-wsauret/flywheel}"
VERSION="${FLYWHEEL_VERSION:-latest}"
# The release origin is stated here and nowhere else. Every request, and every
# redirect hop before it is requested, must name this scheme and one of these
# authorities, so no answer can move a download to another origin, downgrade
# it to another scheme, carry credentials, or name another port. None of these
# authorities states a port, so only the scheme's default port is reachable.
ORIGIN_SCHEME="https"
ORIGIN_AUTHORITY="github.com"
ASSET_AUTHORITIES="objects.githubusercontent.com objects-origin.githubusercontent.com release-assets.githubusercontent.com"
MAX_REDIRECTS=5
GITHUB="${ORIGIN_SCHEME}://${ORIGIN_AUTHORITY}"

# A build archive is a few thousand files, one of which is a large executable.
# These bounds are release-side: a person downloads this installer fresh from
# the release it installs, so the release that ships an archive also ships
# the bounds that admit it. They match RELEASE_BOUNDS in
# scripts/release-acceptance.ts, which refuses to publish an archive past
# them. The installed updater sets no bound of its own (ARCH-DISTRIBUTION-008).
MAX_ENTRIES=4096
MAX_FILE_BYTES=536870912
MAX_TOTAL_BYTES=1073741824
# The compressed download is bounded on its own, so no server can write more
# than this to the disk whatever its listing later claims. It is the release's
# archive bound (RELEASE_BOUNDS.archiveBytes in scripts/release-acceptance.ts).
MAX_ARCHIVE_BYTES=536870912
MAX_CHECKSUMS_BYTES=1048576
# The release page is read for one thing only: the tag its redirect states.
MAX_PAGE_BYTES=8388608
# Every request is bounded twice: a deadline to connect, and a deadline for the
# whole exchange. A silent or a slow server cannot hold an install open.
CONNECT_TIMEOUT=15
MAX_TIME=600
RESOLVE_MAX_TIME=60
# How a musl Linux is recognized, and where its C++ runtime is found. The musl
# build links libstdc++ dynamically, as every musl build of Bun does, and a
# stock Alpine does not install it.
ALPINE_RELEASE="/etc/alpine-release"
MUSL_CXX_RUNTIMES="/usr/lib/libstdc++.so.6 /lib/libstdc++.so.6"

fail() {
  if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then printf '\033[0m' >&2; fi
  printf 'flywheel install: %s\n' "$1" >&2
  exit 1
}

file_bytes() {
  wc -c < "$1" | tr -d ' '
}

# check_hop URL LABEL
# Judges one hop before it is requested. A hop is a URL an answer chose, so it
# is held to the origin this script states: the scheme, an authority that is
# either the repository's origin or a host GitHub redirects release assets to,
# no credentials, no dot segment, and, for the origin, a path inside this
# repository's releases. Asset hosts serve opaque signed paths, so only their
# authority is judged.
check_hop() {
  hop_url="$1"
  hop_label="$2"
  case "$hop_url" in
    "${ORIGIN_SCHEME}://"*) ;;
    *) fail "${hop_label} names ${hop_url}, which is not ${ORIGIN_SCHEME}" ;;
  esac
  hop_rest="${hop_url#"${ORIGIN_SCHEME}://"}"
  hop_authority="${hop_rest%%/*}"
  case "$hop_authority" in
    *@*) fail "${hop_label} names ${hop_url}, which carries credentials" ;;
    "") fail "${hop_label} names ${hop_url}, which names no host" ;;
  esac
  hop_host="$(printf '%s' "$hop_authority" | tr 'A-Z' 'a-z')"
  hop_path="${hop_rest#"$hop_authority"}"
  [ -n "$hop_path" ] || hop_path="/"
  case "${hop_path}/" in
    */../*) fail "${hop_label} names ${hop_url}, which holds a dot segment" ;;
  esac
  for hop_allowed in $ASSET_AUTHORITIES; do
    if [ "$hop_host" = "$hop_allowed" ]; then
      return 0
    fi
  done
  [ "$hop_host" = "$ORIGIN_AUTHORITY" ] || fail "${hop_label} names ${hop_url}, whose host is not one this install may request"
  case "$hop_path" in
    "/${REPO}/releases/"*) ;;
    *) fail "${hop_label} names ${hop_url}, which is outside the releases of ${REPO}" ;;
  esac
}

# fetch URL DESTINATION MAX_BYTES MAX_TIME LABEL
# Downloads one URL and follows its redirects by hand: curl is told to follow
# none, so every hop is read out of the answer, judged, and only then
# requested. The URL that answered is left in fetch_final_url.
fetch() {
  fetch_url="$1"
  fetch_destination="$2"
  fetch_max_bytes="$3"
  fetch_max_time="$4"
  fetch_label="$5"
  fetch_hops=0
  while : ; do
    check_hop "$fetch_url" "$fetch_label"
    fetch_progress="-sS"
    if [ "$fetch_label" = "$asset" ] && [ -t 2 ]; then
      fetch_progress="--progress-bar"
    fi
    fetch_status="$(curl --proto "=${ORIGIN_SCHEME}" --no-location -f "$fetch_progress" --connect-timeout "$CONNECT_TIMEOUT" --max-time "$fetch_max_time" --max-filesize "$fetch_max_bytes" -D "$fetch_headers" -o "$fetch_destination" -w '%{http_code}' "$fetch_url")" ||
      fail "${fetch_label} could not be downloaded from ${fetch_url}"
    case "$fetch_status" in
      200)
        fetch_final_url="$fetch_url"
        return 0
        ;;
      301|302|303|307|308) ;;
      *) fail "${fetch_label} answered with status ${fetch_status}" ;;
    esac
    fetch_hops=$((fetch_hops + 1))
    [ "$fetch_hops" -le "$MAX_REDIRECTS" ] || fail "${fetch_label} redirected more than the ${MAX_REDIRECTS} times allowed"
    fetch_location="$(awk 'tolower(substr($0, 1, 9)) == "location:" { value = substr($0, 10); sub(/\r$/, "", value); gsub(/^[ \t]+|[ \t]+$/, "", value); print value }' "$fetch_headers" | tail -n 1)"
    [ -n "$fetch_location" ] || fail "${fetch_label} redirected without stating where"
    fetch_rest="${fetch_url#"${ORIGIN_SCHEME}://"}"
    case "$fetch_location" in
      /*) fetch_url="${ORIGIN_SCHEME}://${fetch_rest%%/*}${fetch_location}" ;;
      *://*) fetch_url="$fetch_location" ;;
      *) fail "${fetch_label} redirected to ${fetch_location}, which is not a whole location" ;;
    esac
  done
}

printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9._-]{1,100}$' ||
  fail "the repository must be exactly one GitHub owner and repository"
case "${REPO#*/}" in .|..) fail "the repository name is not valid" ;; esac

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

need curl
need tar
need mktemp

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  MINGW*|MSYS*|CYGWIN*) fail "Windows installs must use install.ps1: irm ${GITHUB}/${REPO}/releases/latest/download/install.ps1 | iex" ;;
  *) fail "unsupported OS: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac

# A shell that Rosetta translates reports x86_64 on Apple silicon, where the
# native build is the one to install.
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
  arch="arm64"
fi

platform="${os}-${arch}"

# This is the one place the C library is detected. A binary linked against one
# C library does not start on the other, so a musl Linux installs the musl
# build, whose archive names its C library, and a glibc Linux keeps the name
# without one. The installed build states its own target from then on, so an
# update installs the same kind of build without detecting again.
if [ "$os" = "linux" ]; then
  if [ -f "$ALPINE_RELEASE" ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
    platform="${platform}-musl"
    cxx_runtime=""
    for candidate in $MUSL_CXX_RUNTIMES; do
      if [ -e "$candidate" ]; then
        cxx_runtime="$candidate"
        break
      fi
    done
    [ -n "$cxx_runtime" ] || fail "musl Linux needs the C++ runtime libstdc++ (on Alpine: apk add libstdc++)"
  fi
fi

asset="flywheel-${platform}.tar.gz"

# Private by construction: the staging directory is this account's alone, so
# nothing that is downloaded or extracted is readable or replaceable by another
# user while it is being proved.
umask 077
tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t flywheel-install)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM
chmod 700 "$tmp_dir"
fetch_headers="${tmp_dir}/headers"

# One resolution, one tag. `latest` moves, so it is read exactly once and every
# later request names the tag it resolved to: a release published midway
# through this run cannot mix two releases into one installation.
case "$VERSION" in
  latest)
    fetch "${GITHUB}/${REPO}/releases/latest" "${tmp_dir}/release-page" "$MAX_PAGE_BYTES" "$RESOLVE_MAX_TIME" "the latest release of ${REPO}"
    resolved="$fetch_final_url"
    rm -f "${tmp_dir}/release-page"
    case "$resolved" in "${GITHUB}/${REPO}/releases/tag/"*) ;; *) fail "the latest release redirected outside ${REPO}" ;; esac
    tag="${resolved##*/}"
    ;;
  v*) tag="$VERSION" ;;
  *) tag="v${VERSION}" ;;
esac

printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail "the release tag ${tag} is not a vMAJOR.MINOR.PATCH release"

base_url="${GITHUB}/${REPO}/releases/download/${tag}"

archive_path="${tmp_dir}/${asset}"
checksums_path="${tmp_dir}/SHASUMS256.txt"
check_path="${tmp_dir}/${asset}.sha256"

installed_metadata="$HOME/.flywheel/current/build.json"
if [ -f "$installed_metadata" ]; then
  installed_version="$(awk -F '"' '$2 == "version" && $4 ~ /^[0-9]+\.[0-9]+\.[0-9]+$/ { print $4; exit }' "$installed_metadata")"
  printf 'Installed version: %s\n' "${installed_version:-unknown}"
fi

# This is a diagnostic preflight, not activation authority. Only the canonical
# build.json written by build-binary.ts, at its physical installed location,
# establishes an active version. Unknown state still reaches the install engine.
# Do not run or hash the old payload: a verified newer build can repair it.
if [ "$VERSION" != "latest" ] &&
  active_dir="$(CDPATH= cd -P "$HOME/.flywheel/current" 2>/dev/null && pwd -P)" &&
  versions_root="$(CDPATH= cd -P "$HOME/.flywheel/versions" 2>/dev/null && pwd -P)" &&
  [ "${active_dir%/*/*}" = "$versions_root" ] &&
  [ -f "$active_dir/build.json" ]; then
  active_relative="${active_dir#"$versions_root"/}"
  active_version="${active_relative%/*}"
  active_build="${active_relative##*/}"
  if awk -v version="$active_version" -v build="$active_build" -v requested="${tag#v}" '
    { text = text $0 "\n" }
    END {
      if (version !~ /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/) exit 1
      space = "[[:space:]]*"
      record = "^" space "\\{" space "\"version\"" space ":" space "\"[0-9.]+\"" space ","
      record = record space "\"buildId\"" space ":" space "\"[0-9a-f]+\"" space ","
      record = record space "\"asset\"" space ":" space "\"flywheel-((darwin|win32)-(arm64|x64)|linux-(arm64|x64)(-musl)?)\\.tar\\.gz\"" space "\\}" space "$"
      if (text !~ record) exit 1
      # A regex separator keeps macOS awk from also splitting at line breaks.
      split(text, fields, /"/)
      if (fields[4] != version || length(fields[8]) != 64 || fields[8] != "" build) exit 1
      split(requested, wanted, ".")
      split(version, active, ".")
      for (part = 1; part <= 3; part++) {
        if (wanted[part] + 0 < active[part] + 0) exit 0
        if (wanted[part] + 0 > active[part] + 0) exit 1
      }
      exit 1
    }
  ' "$active_dir/build.json"; then
    fail "requested version ${tag#v} is older than active version ${active_version}; this installer does not downgrade. Choose a published version newer than ${active_version} and rerun with FLYWHEEL_VERSION set to it. If none exists, wait for a newer release."
  fi
fi
printf '\nInstalling flywheel version: %s\n' "${tag#v}"
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  printf '\033[38;5;214m' >&2
  trap 'printf "\033[0m" >&2; cleanup' EXIT INT TERM
fi
fetch "${base_url}/${asset}" "$archive_path" "$MAX_ARCHIVE_BYTES" "$MAX_TIME" "$asset"
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  printf '\033[0m' >&2
  trap cleanup EXIT INT TERM
fi
fetch "${base_url}/SHASUMS256.txt" "$checksums_path" "$MAX_CHECKSUMS_BYTES" "$RESOLVE_MAX_TIME" "SHASUMS256.txt"

# curl refuses a download whose stated length is over the cap, but a server
# that states no length is only caught here, on the bytes that arrived.
archive_bytes="$(file_bytes "$archive_path")"
[ "$archive_bytes" -le "$MAX_ARCHIVE_BYTES" ] || fail "${asset} downloaded ${archive_bytes} bytes, more than the ${MAX_ARCHIVE_BYTES} allowed"
checksums_bytes="$(file_bytes "$checksums_path")"
[ "$checksums_bytes" -le "$MAX_CHECKSUMS_BYTES" ] || fail "SHASUMS256.txt downloaded ${checksums_bytes} bytes, more than the ${MAX_CHECKSUMS_BYTES} allowed"

grep "  ${asset}\$" "$checksums_path" > "$check_path" || fail "${asset} is missing from SHASUMS256.txt"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp_dir" && sha256sum -c "$(basename "$check_path")" >/dev/null) || fail "checksum mismatch for ${asset}"
elif command -v shasum >/dev/null 2>&1; then
  (cd "$tmp_dir" && shasum -a 256 -c "$(basename "$check_path")" >/dev/null) || fail "checksum mismatch for ${asset}"
else
  fail "sha256sum or shasum is required to verify the download"
fi

# Admission: every entry is judged on its name, on its type, and on the size it
# states, while the archive is still only a listing. A build payload is a plain
# tree of regular files and directories under one relative root, so an absolute
# name, a dot component, a backslash, a repeated path, a link, a device, a
# FIFO, or a socket is refused rather than extracted and inspected afterwards.
root="flywheel-${platform}"
names="${tmp_dir}/entry-names"
verbose="${tmp_dir}/entry-verbose"
meta="${tmp_dir}/entry-meta"
listing="${tmp_dir}/entry-listing"
normalized="${tmp_dir}/entry-normalized"
tar -tzf "$archive_path" > "$names" || fail "${asset} cannot be listed"
tar -tzvf "$archive_path" > "$verbose" || fail "${asset} cannot be listed"
# GNU tar prints owner and group as one field, bsdtar prints them as two, so
# the stated size is field 3 or field 5.
awk '{ if ($2 ~ /\//) print substr($1, 1, 1) "\t" $3; else print substr($1, 1, 1) "\t" $5 }' < "$verbose" > "$meta" || fail "${asset} cannot be listed"

entry_count="$(wc -l < "$names" | tr -d ' ')"
meta_count="$(wc -l < "$meta" | tr -d ' ')"
[ "$entry_count" -gt 0 ] || fail "${asset} lists no entries"
[ "$entry_count" -eq "$meta_count" ] || fail "${asset} lists entries that cannot be read one to a line"
[ "$entry_count" -le "$MAX_ENTRIES" ] || fail "${asset} lists ${entry_count} entries, more than the ${MAX_ENTRIES} allowed"

paste "$meta" "$names" > "$listing" || fail "${asset} cannot be listed"
: > "$normalized"
total_bytes=0
tab="$(printf '\t')"
while IFS="$tab" read -r entry_type entry_size entry_name; do
  case "$entry_type" in
    -|d) ;;
    *) fail "${asset} holds an entry that is not a regular file or a directory" ;;
  esac
  case "$entry_name" in
    *\\*) fail "${asset} holds an entry name that holds a backslash" ;;
  esac
  norm="${entry_name%/}"
  case "$norm" in
    /*|[A-Za-z]:*) fail "${asset} holds an entry name that is absolute" ;;
  esac
  case "/${norm}/" in
    */../*|*/./*|*//*) fail "${asset} holds an entry name that holds a dot or an empty component" ;;
  esac
  case "$norm" in
    "$root"|"${root}/"*) ;;
    *) fail "${asset} holds ${entry_name}, which is outside its ${root} root" ;;
  esac
  case "$entry_size" in
    ""|*[!0-9]*) fail "${asset} states a size for ${norm} that is not a whole count of bytes" ;;
  esac
  if [ "$entry_type" = "d" ]; then
    [ "$entry_size" -eq 0 ] || fail "${asset} states ${entry_size} bytes of content for the directory ${norm}"
  else
    [ "$entry_size" -le "$MAX_FILE_BYTES" ] || fail "${asset} states ${entry_size} bytes for ${norm}, more than the ${MAX_FILE_BYTES} allowed for one file"
    total_bytes=$((total_bytes + entry_size))
    [ "$total_bytes" -le "$MAX_TOTAL_BYTES" ] || fail "${asset} states more than the ${MAX_TOTAL_BYTES} bytes allowed for one archive"
  fi
  printf '%s\n' "$norm" >> "$normalized"
done < "$listing"

[ -z "$(sort "$normalized" | uniq -d | head -n 1)" ] || fail "${asset} holds two entries that name one path"

tar -xzf "$archive_path" -C "$tmp_dir" || fail "${asset} could not be extracted"

# The extracted tree is proved again, because admission judged what the archive
# said it held and this judges what is actually on the disk.
if [ -n "$(find "${tmp_dir}/${root}" ! -type f ! -type d -print 2>/dev/null | head -n 1)" ]; then
  fail "${asset} extracted an entry that is neither a regular file nor a directory"
fi
if [ -n "$(find "${tmp_dir}/${root}" -type f -links +1 -print 2>/dev/null | head -n 1)" ]; then
  fail "${asset} extracted a file that is reachable under another name"
fi
extracted_kb="$(du -sk "${tmp_dir}/${root}" | cut -f1)"
[ "$((extracted_kb * 1024))" -le "$MAX_TOTAL_BYTES" ] || fail "${asset} extracted more than the ${MAX_TOTAL_BYTES} bytes allowed"

installer="${tmp_dir}/${root}/install.sh"
[ -f "$installer" ] || fail "the archive did not contain install.sh"
[ -x "$installer" ] || fail "the archive's install.sh is not executable"

"$installer" --downloaded
cleanup
trap - EXIT INT TERM

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  printf '\n\033[2m█▀▀▀▀ █    █   █\033[0m █   █ █   █ █▀▀▀▀ █▀▀▀▀ █\n'
  printf '\033[2m█▄▄▄  █     ▀▄▀ \033[0m █ ▄ █ █▄▄▄█ █▄▄▄  █▄▄▄  █\n'
  printf '\033[2m█     █      █  \033[0m █ █ █ █   █ █     █     █\n'
  printf '\033[2m▀     ▀▀▀▀▀  ▀  \033[0m  ▀ ▀  ▀   ▀ ▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀▀\n\n'
else
  printf '\nFlywheel installed\n\n'
fi
printf 'To start:\n\n  cd <project>  # Open your project\n  flywheel      # Start Flywheel\n\n'
