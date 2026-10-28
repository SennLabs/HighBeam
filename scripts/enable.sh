#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Add an extension to org.gnome.shell enabled-extensions without needing the
# running shell to know about it yet (gnome-extensions enable requires that).
set -eu
uuid="$1"
current=$(gsettings get org.gnome.shell enabled-extensions)
case "$current" in
    *"'$uuid'"*) echo "$uuid is already enabled"; exit 0 ;;
    "@as []") new="['$uuid']" ;;
    *) new=$(printf '%s' "$current" | sed "s/]\$/, '$uuid']/") ;;
esac
gsettings set org.gnome.shell enabled-extensions "$new"
echo "Enabled $uuid (takes effect at next shell start)"
