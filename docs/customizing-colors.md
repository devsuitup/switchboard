# Customizing colors

## App appearance

Choose **Global Settings → General → Appearance → Theme**: **Dark**
(the default), **Light** or **System**, then **Save Settings**. System follows
the operating system's light/dark preference. Changes update the app, file
editors and open terminals without a restart.

## Terminal colors

**General → Terminal → Terminal Theme** chooses the terminal palette. See
[Terminal theme](terminal.md#theme) for the choices. Light appearance uses the light terminal palette for every terminal. Dark
appearance uses your selected Terminal Theme.

## Source customization

For colors beyond these settings, edit the theme variables in
`public/style.css` in a source checkout and follow the
[development guide](development.md). Dark tokens are in `:root`; light
overrides are in `:root[data-theme="light"]`.

This replaces the v0.0.30 guide to replacing color literals in an installed
`app.asar`. The old `scripts/apply-theme.ps1` literal mappings do not define
the current light and dark themes. Use the built-in settings for ordinary
appearance changes.
