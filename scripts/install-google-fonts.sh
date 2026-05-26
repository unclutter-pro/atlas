#!/usr/bin/env bash
# install-google-fonts.sh
#
# Downloads a curated set of commonly-used Google Fonts as variable .ttf
# files and installs them under /usr/share/fonts/google/<family>/.
# Runs `fc-cache -f` at the end so the new fonts are picked up immediately.
#
# Why a script and not inline curls in the Dockerfile?
#   - Lists of fonts grow; we don't want each addition to balloon the
#     Dockerfile's mega-RUN.
#   - Cache invalidation: a single dedicated layer rebuilds only when this
#     script changes, leaving the rest of the image untouched.
#   - Reusable: a customer or developer can rerun the script on a live pod
#     to refresh fonts without rebuilding the image.
#
# Source: github.com/google/fonts (OFL licensed unless stated otherwise).
# Format: variable fonts. Typst 0.14+ resolves weights from variable .ttf
# correctly; family name is the same as the static cuts (e.g. "Crimson Pro").
#
# Adding a font: append a line to the FONTS array. Format:
#   "family-folder|destination-subdir|url"
# The destination-subdir lives under /usr/share/fonts/google/.

set -euo pipefail

FONTS_ROOT="/usr/share/fonts/google"
GOOGLE_FONTS_BASE="https://github.com/google/fonts/raw/main/ofl"

# Curated set: serifs first (formal/editorial), then sans (modern/clean),
# then display, then mono. Roman + italic where both exist. Italic-less
# families have a single entry. Some families are static-only (no variable
# upstream) — those list multiple weights explicitly.
#
# A note on "Google Sans": Google does not publish that family to the
# github.com/google/fonts repo (it's a proprietary product font shipped
# only via the closed Google Fonts service). `Roboto Flex` below is the
# closest open replacement and the family Google themselves point to.
FONTS=(
  # --- Serifs ---
  "crimsonpro|crimson-pro|${GOOGLE_FONTS_BASE}/crimsonpro/CrimsonPro%5Bwght%5D.ttf"
  "crimsonpro|crimson-pro|${GOOGLE_FONTS_BASE}/crimsonpro/CrimsonPro-Italic%5Bwght%5D.ttf"
  "lora|lora|${GOOGLE_FONTS_BASE}/lora/Lora%5Bwght%5D.ttf"
  "lora|lora|${GOOGLE_FONTS_BASE}/lora/Lora-Italic%5Bwght%5D.ttf"
  "merriweather|merriweather|${GOOGLE_FONTS_BASE}/merriweather/Merriweather%5Bopsz,wdth,wght%5D.ttf"
  "merriweather|merriweather|${GOOGLE_FONTS_BASE}/merriweather/Merriweather-Italic%5Bopsz,wdth,wght%5D.ttf"
  "ebgaramond|eb-garamond|${GOOGLE_FONTS_BASE}/ebgaramond/EBGaramond%5Bwght%5D.ttf"
  "ebgaramond|eb-garamond|${GOOGLE_FONTS_BASE}/ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf"
  "playfairdisplay|playfair-display|${GOOGLE_FONTS_BASE}/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf"
  "playfairdisplay|playfair-display|${GOOGLE_FONTS_BASE}/playfairdisplay/PlayfairDisplay-Italic%5Bwght%5D.ttf"
  "sourceserif4|source-serif-4|${GOOGLE_FONTS_BASE}/sourceserif4/SourceSerif4%5Bopsz,wght%5D.ttf"
  "sourceserif4|source-serif-4|${GOOGLE_FONTS_BASE}/sourceserif4/SourceSerif4-Italic%5Bopsz,wght%5D.ttf"

  # --- Sans-serifs (Inter, IBM Plex Sans, Noto Sans, Ubuntu are already from apt) ---
  "roboto|roboto|${GOOGLE_FONTS_BASE}/roboto/Roboto%5Bwdth,wght%5D.ttf"
  "roboto|roboto|${GOOGLE_FONTS_BASE}/roboto/Roboto-Italic%5Bwdth,wght%5D.ttf"
  "robotoflex|roboto-flex|${GOOGLE_FONTS_BASE}/robotoflex/RobotoFlex%5BGRAD,XOPQ,XTRA,YOPQ,YTAS,YTDE,YTFI,YTLC,YTUC,opsz,slnt,wdth,wght%5D.ttf"
  "manrope|manrope|${GOOGLE_FONTS_BASE}/manrope/Manrope%5Bwght%5D.ttf"
  "worksans|work-sans|${GOOGLE_FONTS_BASE}/worksans/WorkSans%5Bwght%5D.ttf"
  "worksans|work-sans|${GOOGLE_FONTS_BASE}/worksans/WorkSans-Italic%5Bwght%5D.ttf"
  "raleway|raleway|${GOOGLE_FONTS_BASE}/raleway/Raleway%5Bwght%5D.ttf"
  "raleway|raleway|${GOOGLE_FONTS_BASE}/raleway/Raleway-Italic%5Bwght%5D.ttf"
  "geist|geist|${GOOGLE_FONTS_BASE}/geist/Geist%5Bwght%5D.ttf"

  # --- Fira Sans (static cuts — no variable axis upstream).
  # Keeps Regular/Italic + Bold/BoldItalic + Medium for the most common weight calls. ---
  "firasans|fira-sans|${GOOGLE_FONTS_BASE}/firasans/FiraSans-Regular.ttf"
  "firasans|fira-sans|${GOOGLE_FONTS_BASE}/firasans/FiraSans-Italic.ttf"
  "firasans|fira-sans|${GOOGLE_FONTS_BASE}/firasans/FiraSans-Medium.ttf"
  "firasans|fira-sans|${GOOGLE_FONTS_BASE}/firasans/FiraSans-Bold.ttf"
  "firasans|fira-sans|${GOOGLE_FONTS_BASE}/firasans/FiraSans-BoldItalic.ttf"

  # --- Display / decorative (single weight each) ---
  "anton|anton|${GOOGLE_FONTS_BASE}/anton/Anton-Regular.ttf"
  "lobster|lobster|${GOOGLE_FONTS_BASE}/lobster/Lobster-Regular.ttf"

  # --- Monospace (JetBrains Mono + IBM Plex Mono are already from apt) ---
  "firacode|fira-code|${GOOGLE_FONTS_BASE}/firacode/FiraCode%5Bwght%5D.ttf"
  "firamono|fira-mono|${GOOGLE_FONTS_BASE}/firamono/FiraMono-Regular.ttf"
  "firamono|fira-mono|${GOOGLE_FONTS_BASE}/firamono/FiraMono-Medium.ttf"
  "firamono|fira-mono|${GOOGLE_FONTS_BASE}/firamono/FiraMono-Bold.ttf"
)

echo "Installing ${#FONTS[@]} Google Font files into ${FONTS_ROOT}…"

mkdir -p "${FONTS_ROOT}"

for entry in "${FONTS[@]}"; do
  IFS='|' read -r family subdir url <<<"${entry}"

  dest_dir="${FONTS_ROOT}/${subdir}"
  filename="$(basename "${url}")"
  # %5B / %5D are URL-encoded [ and ] — decode for cleaner on-disk names.
  filename="${filename//%5B/[}"
  filename="${filename//%5D/]}"
  dest_file="${dest_dir}/${filename}"

  mkdir -p "${dest_dir}"

  if [[ -s "${dest_file}" ]]; then
    echo "  ✓ ${subdir}/${filename} (already present, skipping)"
    continue
  fi

  # -f fails on HTTP 4xx/5xx, --retry covers transient network blips.
  # We deliberately do NOT pipe through tar/unzip; these are raw .ttf files.
  if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 60 -o "${dest_file}" "${url}"; then
    echo "  ✗ FAILED: ${url}" >&2
    rm -f "${dest_file}"  # avoid leaving an empty/partial file behind
    exit 1
  fi

  # Sanity-check: TTF files start with 0x00010000 (TrueType) or "OTTO" (CFF/OTF).
  # A common failure mode is GitHub serving an HTML error page (200 OK with
  # HTML body) when the repo path is wrong — guard against that. Uses `od`
  # because xxd isn't in the base Ubuntu image (no vim-common).
  magic=$(head -c 4 "${dest_file}" | od -An -t x1 -N 4 | tr -d ' \n')
  if [[ "${magic}" != "00010000" && "${magic}" != "4f54544f" ]]; then
    echo "  ✗ Downloaded file is not a TTF/OTF: ${dest_file} (magic: ${magic})" >&2
    rm -f "${dest_file}"
    exit 1
  fi

  size=$(stat -c%s "${dest_file}")
  echo "  ✓ ${subdir}/${filename} (${size} bytes)"
done

echo "Refreshing fontconfig cache…"
fc-cache -f "${FONTS_ROOT}"

# Verify each family is now known to fontconfig by querying a representative
# name. Mostly informational; doesn't fail the build because some users may
# have removed entries from FONTS and that's fine.
echo "Installed families known to fontconfig:"
for family in "Crimson Pro" "Lora" "Merriweather" "EB Garamond" "Playfair Display" "Source Serif 4" \
              "Roboto" "Roboto Flex" "Manrope" "Work Sans" "Raleway" "Geist" "Fira Sans" \
              "Anton" "Lobster" "Fira Code" "Fira Mono"; do
  if fc-list : family | grep -qi "^${family}\$\|^${family},"; then
    echo "  ✓ ${family}"
  else
    echo "  · ${family} (not registered — check FONTS list)"
  fi
done

echo "Done."
