# Flywheel key reference

This file is generated from the key bindings. Run `bun run docs:generate` to update it.

These are the default keys of the terminal interface. The `/shortcuts` command shows the same list with your changes applied.

## Prompt

| Keys | Action |
| --- | --- |
| `alt+enter / enter` | Send prompt |
| `shift+enter / ctrl+enter` | Insert new line |
| `esc` | Close/cancel/interrupt |
| `up arrow (empty prompt)` | Open prompt history |
| `up/down arrows · enter · esc` | Navigate prompt lists |
| `tab` | Complete slash command |
| `right arrow` | Accept ghost text |
| `ctrl+v / super+v` | Paste clipboard image |
| `/help` | Commands |

## Text editing

| Keys | Action |
| --- | --- |
| `left arrow / ctrl+b` | Move one character left |
| `right arrow / ctrl+f` | Move one character right |
| `up arrow` | Move one visual line up |
| `down arrow` | Move one visual line down |
| `home / super+up arrow` | Jump to entry start |
| `end / super+down arrow` | Jump to entry end |
| `ctrl+a` | Jump to line start |
| `ctrl+e` | Jump to line end |
| `alt+a / super+left arrow` | Jump to wrapped-line start |
| `alt+e / super+right arrow` | Jump to wrapped-line end |
| `ctrl+backspace / alt+backspace` | Delete previous word |
| `alt+d / alt+delete / ctrl+delete` | Delete next word |
| `ctrl+shift+d` | Delete current line |
| `ctrl+k` | Delete to line end |
| `ctrl+u` | Delete to line start |
| `backspace / shift+backspace` | Delete previous character |
| `ctrl+d / delete / shift+delete` | Delete next character |
| `ctrl+- / super+z / ctrl+z` | Undo text edit |
| `ctrl+. / shift+super+z / ctrl+y / ctrl+shift+z` | Redo text edit |
| `alt+f / alt+right arrow / ctrl+right arrow` | Move one word forward |
| `alt+b / alt+left arrow / ctrl+left arrow` | Move one word backward |

## Selection

| Keys | Action |
| --- | --- |
| `shift+left arrow` | Select one character left |
| `shift+right arrow` | Select one character right |
| `shift+up arrow` | Select one visual line up |
| `shift+down arrow` | Select one visual line down |
| `shift+home / shift+super+up arrow` | Select to entry start |
| `shift+end / shift+super+down arrow` | Select to entry end |
| `ctrl+shift+e` | Select to line end |
| `alt+shift+a / shift+super+left arrow` | Select to wrapped-line start |
| `alt+shift+e / shift+super+right arrow` | Select to wrapped-line end |
| `alt+shift+f / alt+shift+right arrow` | Select one word forward |
| `alt+shift+b / alt+shift+left arrow` | Select one word backward |
| `ctrl+shift+a / super+a` | Select all |
| `ctrl+shift+a / super+a, then backspace` | Clear entry after Select all |

## App navigation

| Keys | Action |
| --- | --- |
| `ctrl+p` | Commands |
| `ctrl+n` | New chat |
| `ctrl+s` | Sessions |
| `ctrl+w` | Close tab |
| `ctrl+r` | Resume an interrupted session |
| `tab / shift+tab` | Cycle sessions |
| `ctrl+1 .. ctrl+9` | Activate tab |
| `pageup / pagedown` | Scroll output |
| `ctrl+pageup / ctrl+pagedown` | Scroll half page |
| `home / end` | Jump to top / bottom |

## Changing a key

Set a new chord for an app navigation key in the `[keybindings]` table of `~/.flywheel/flywheel.toml`, keyed by its command id, for example `"tab.close" = "ctrl+q"`. A chord is modifiers (`ctrl`, `meta`, `shift`) and one key, joined by `+`. The prompt, text editing, and selection keys cannot be changed.

| Command id | Default | Action |
| --- | --- | --- |
| `help` | `ctrl+p` | Commands |
| `new` | `ctrl+n` | New chat |
| `sessions` | `ctrl+s` | Sessions |
| `tab.close` | `ctrl+w` | Close tab |
| `resume` | `ctrl+r` | Resume an interrupted session |
| `tab.next` | `tab` | Cycle sessions |
| `tab.previous` | `shift+tab` | Cycle sessions |
| `tab.1` | `ctrl+1` | Activate tab |
| `tab.2` | `ctrl+2` | Activate tab |
| `tab.3` | `ctrl+3` | Activate tab |
| `tab.4` | `ctrl+4` | Activate tab |
| `tab.5` | `ctrl+5` | Activate tab |
| `tab.6` | `ctrl+6` | Activate tab |
| `tab.7` | `ctrl+7` | Activate tab |
| `tab.8` | `ctrl+8` | Activate tab |
| `tab.9` | `ctrl+9` | Activate tab |
| `output.page-up` | `pageup` | Scroll output |
| `output.page-down` | `pagedown` | Scroll output |
| `output.half-page-up` | `ctrl+pageup` | Scroll half page |
| `output.half-page-down` | `ctrl+pagedown` | Scroll half page |
| `output.top` | `home` | Jump to top / bottom |
| `output.bottom` | `end` | Jump to top / bottom |
