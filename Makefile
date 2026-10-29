# SPDX-License-Identifier: GPL-2.0-or-later

UUID      := highbeam@sennlab.com
EXT_DIR   := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
BUILD_DIR := build
ZIP       := $(BUILD_DIR)/$(UUID).shell-extension.zip

.PHONY: all schemas install uninstall enable pack nested logs lint test pot clean

all: schemas

schemas:
	glib-compile-schemas --strict schemas/

# Symlink the working tree into the extensions directory so edits are picked up
# by the next shell start (nested shell, or log out/in on Wayland).
install: schemas
	mkdir -p $(dir $(EXT_DIR))
	ln -sfn $(CURDIR) $(EXT_DIR)

uninstall:
	rm -f $(EXT_DIR)

# Adds HighBeam to the enabled list. Takes effect at the next shell start.
enable:
	./scripts/enable.sh $(UUID)

pack:
	mkdir -p $(BUILD_DIR)
	gnome-extensions pack --force --out-dir=$(BUILD_DIR) --podir=po \
		--extra-source=src --extra-source=LICENSE .
	@# With no translations yet, pack still adds an empty locale/ folder.
	$(if $(wildcard po/*.po),,zip -q -d $(ZIP) 'locale/')
	@echo "Built $(ZIP)"

# A GNOME Shell in a window, for testing without logging out. A nested
# session prints a lot of unrelated noise, so the terminal only shows lines
# mentioning HighBeam (plus two lines of context). VERBOSE=1 shows everything;
# the full output is always saved to build/nested.log.
nested: install
	@mkdir -p $(BUILD_DIR)
	@echo "Full log: $(BUILD_DIR)/nested.log (VERBOSE=1 make nested to print everything)"
	@MUTTER_DEBUG_DUMMY_MODE_SPECS=$${MODE:-1600x1000} \
	MUTTER_DEBUG_DUMMY_MONITOR_SCALES=$${SCALE:-1} \
		dbus-run-session -- gnome-shell --devkit --wayland 2>&1 \
		| tee $(BUILD_DIR)/nested.log \
		| if [ -n "$$VERBOSE" ]; then cat; else grep -i --line-buffered --no-group-separator -B2 highbeam; fi

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

lint:
	npx --yes eslint@10 .

test:
	gjs -m tests/run.js

# Translation template, from the JavaScript sources and the settings schema.
# Needs xgettext (the gettext package). Translations go in po/<lang>.po.
pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=N_ \
		--add-comments=Translators: --package-name=HighBeam \
		--output=po/highbeam.pot extension.js prefs.js $$(find src -name '*.js' | sort)
	xgettext --from-code=UTF-8 --join-existing --output=po/highbeam.pot \
		schemas/org.gnome.shell.extensions.highbeam.gschema.xml

clean:
	rm -rf $(BUILD_DIR) schemas/gschemas.compiled
