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

## Community guide: patching `app.asar` (v0.0.30)

Jean-Luc PIETRI wrote a guide and a PowerShell script,
[`scripts/apply-theme.ps1`](../scripts/apply-theme.ps1), that recolor an
installed build without a source checkout. The script rewrites the stylesheet
inside `resources/app.asar` (a cream "Cowork" light theme, a plain background
color, or a revert to the saved original). It was tested on v0.0.30 on
Windows, before the built-in themes existed, and its color mappings do not
follow the current theme variables. An auto-update replaces `app.asar` and
removes the patch, so the script has to be run again after each update.
