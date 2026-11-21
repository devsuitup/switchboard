// see .ai/contexts/ipc-bridge.md (Archived projects manager)
let activeArchivedProjectsManager = null;

function renderArchivedProjects(container, { entries, kinds = {}, dates = {}, folders = {}, hosts = [], projects = [], onCount }) {
  let projectEntries = new Set(entries.filter(entry => kinds[entry] !== 'delete'));
  folders = { ...folders };
  let archived = [...new Set([...projectEntries, ...Object.keys(folders)])].filter(entry => kinds[entry] !== 'delete');
  const selected = new Set(), folded = new Set();
  let busy = false;
  container.innerHTML = `<div class="archived-toolbar">
    <button type="button" class="settings-action-btn archived-search-toggle" aria-label="Search archived projects" aria-expanded="false">Search</button>
    <input class="settings-input archived-filter" type="search" aria-label="Filter archived projects by name, path or host" placeholder="Filter by name, path or host…">
    <button type="button" class="settings-action-btn archived-bulk" disabled>Unarchive selected</button>
    </div><div class="archived-list"></div>`;
  const list = container.querySelector('.archived-list');
  const filter = container.querySelector('.archived-filter');
  const bulk = container.querySelector('.archived-bulk');
  const search = container.querySelector('.archived-search-toggle');
  const identity = entry => {
    const { alias: remoteAlias, folder: entryPath } = parseFolderKey(entry);
    const projectPath = remoteAlias && entryPath === '' ? '/' : entryPath;
    const folder = (remoteAlias === null ? '' : remoteAlias + '::') + encodeProjectPath(projectPath);
    const cached = projects.find(p => (p.remoteAlias || null) === remoteAlias && p.projectPath === projectPath);
    return { projectPath, remoteAlias, folder, sessions: cached?.sessions || [], cached, name: shortProjectPath(projectPath) || projectPath };
  };
  const reload = async () => {
    if (typeof loadProjects === 'function') await Promise.resolve(loadProjects()).catch(error => {
      if (!loadProjects.state?.reportedErrors?.has(error)) console.warn('[switchboard] project reload failed', error);
    });
    if (activeArchivedProjectsManager?.container !== container && activeArchivedProjectsManager?.container.isConnected) {
      await activeArchivedProjectsManager.refresh();
    }
  };
  const fail = (title, errors, returnFocus) => appAlert({ title, message: errors.join('\n'), returnFocus });
  function selection() {
    bulk.textContent = selected.size ? `Unarchive selected (${selected.size})` : 'Unarchive selected';
    bulk.disabled = busy || !selected.size;
    list.querySelectorAll('.archived-select').forEach(box => { box.checked = selected.has(box.dataset.entry); });
    list.querySelectorAll('.archived-select-all').forEach(box => {
      const visible = [...box.closest('.archived-group').querySelectorAll('.archived-select')];
      box.checked = visible.length > 0 && visible.every(item => item.checked);
      box.indeterminate = visible.some(item => item.checked) && !box.checked;
    });
  }
  function lock(value) {
    busy = value;
    container.querySelectorAll('.archived-select, .archived-select-all, .archived-unarchive, .archived-delete').forEach(control => { control.disabled = busy || control.dataset.unavailable === 'true'; });
    selection();
  }
  async function undo(restored) {
    if (busy) return;
    lock(true);
    const errors = [];
    for (const entry of restored) {
      const project = identity(entry);
      try {
        const result = await window.api.archiveProjectSettings(project.projectPath, project.folder);
        if (!result?.ok) throw new Error(result?.error || 'No archive result');
        if (!archived.includes(entry)) archived.push(entry);
        projectEntries.add(entry);
        kinds[entry] = 'archive';
        const latest = await window.api.getSetting('global');
        dates = latest?.hiddenProjectArchivedAt || dates;
      } catch (error) { errors.push(`${project.name}: ${error.message}`); }
    }
    lock(false); render(); await reload();
    if (errors.length) await fail('Could not archive project', errors, filter);
  }
  async function restore(targets, button) {
    if (busy) return;
    lock(true);
    const restored = [], restoredProjects = [], restoredFolders = [], errors = [];
    for (const entry of targets) {
      try {
        if (projectEntries.has(entry)) {
          const result = await window.api.unarchiveProject(entry);
          if (!result?.ok) throw new Error(result?.error || 'No unarchive result');
          projectEntries.delete(entry);
          restoredProjects.push(entry);
        }
        if (Object.hasOwn(folders, entry)) {
          const result = await window.api.unarchiveFolder(entry);
          if (!result?.ok && !(restoredProjects.includes(entry) && result?.code === 'NOT_ARCHIVED')) {
            throw new Error(result?.error || 'No unarchive result');
          }
          delete folders[entry];
          restoredFolders.push(entry);
        }
        archived = archived.filter(item => item !== entry); selected.delete(entry); restored.push(entry);
      } catch (error) { errors.push(`${identity(entry).name}: ${error.message}`); }
    }
    lock(false);
    if (restored.length || restoredProjects.length) {
      render(); filter.focus(); await reload();
      const completed = [...new Set([...restored, ...restoredProjects])];
      const noticeId = 'archived-restored:' + completed.join('|');
      const message = completed.length === 1
        ? `${restoredProjects.length ? 'Project' : 'Folder'} "${identity(completed[0]).name}" restored.`
        : `${completed.length} ${restoredFolders.length ? 'projects and folders' : 'projects'} restored.`;
      const notice = showAppNotice({ id: noticeId, kind: restoredProjects.length ? 'undo' : 'info', dismissOnAction: false,
        message: message + (restoredFolders.length
          ? `${restoredProjects.length ? ' Undo re-archives projects only.' : ''} To archive folders again, use Archive folder.` : ''),
        ...(restoredProjects.length ? { actionLabel: 'Undo', onAction: () => {
          if (busy) return;
          clearAppNotice(noticeId);
          return undo(restoredProjects);
        } } : {}) });
      notice.dataset.restoredEntries = JSON.stringify(restoredProjects);
      notice.dataset.loadGeneration = loadProjects.state?.started || 0;
    }
    if (errors.length) await fail('Could not unarchive project', errors, button.isConnected ? button : filter);
  }
  async function remove(entry, button) {
    if (busy) return;
    lock(true);
    const row = button.closest('.archived-row'), project = identity(entry);
    const reason = row.querySelector('.archived-delete-reason');
    reason.textContent = 'Checking deletion availability…';
    try {
      if (await confirmAndDeleteProjectFolder(project, button, { reuseInitialPreview: true,
        onDialogOpen: () => { reason.textContent = ''; }, onUnavailable: (reply, message) => {
        if (!row.isConnected) return;
        const grouped = reply?.code === 'IDENTITY_UNAVAILABLE' && reply.error === 'Folder and path hints conflict.'
          && project.remoteAlias === null && worktreeGroupingPath(project.projectPath) !== project.projectPath;
        const retryable = !grouped;
        reason.textContent = grouped ? 'This worktree is grouped under its repository. To remove it from Switchboard, delete its repository instead.'
          : message.replace(/\s*(?:Close and reopen Delete to retry\.|Retry preview, or cancel\.)/g, '')
            + (retryable ? ' Reopen the menu and click Delete project to try again.' : '');
        button.dataset.unavailable = 'true'; button.dataset.retryable = String(retryable); button.disabled = true;
      } })) {
        projectEntries.delete(entry); delete folders[entry];
        archived = archived.filter(item => item !== entry); selected.delete(entry); render(); filter.focus();
      }
    } catch (error) { await fail('Could not delete project', [error.message], button); }
    finally {
      if (reason.textContent === 'Checking deletion availability…') reason.textContent = '';
      lock(false);
      if (button.isConnected) (button.disabled ? row.querySelector('summary') : button).focus();
    }
  }
  function render() {
    if (container.isConnected) onCount?.(archived.length);
    const query = filter.value.trim().toLowerCase();
    const matches = archived.filter(entry => {
      const p = identity(entry);
      return [p.name, p.projectPath, p.remoteAlias || 'Local', p.remoteAlias && remoteHostLabel(p.remoteAlias, hosts)].join(' ').toLowerCase().includes(query);
    });
    for (const entry of selected) if (!matches.includes(entry)) selected.delete(entry);
    if (!matches.length) {
      list.innerHTML = `<div class="archived-empty" role="status">${query ? `No archived item matches "${escapeHtml(filter.value.trim())}". <button type="button" class="settings-action-btn archived-clear">Clear filter</button>` : 'No archived project. Archive Project (a project’s settings) or Archive folder (a project header) lists it here.'}</div>`;
      list.querySelector('.archived-clear')?.addEventListener('click', clearFilter);
      selection(); return;
    }
    const aliases = [...new Set([null, ...hosts.map(h => h.alias.trim()), ...matches.map(entry => identity(entry).remoteAlias)])];
    list.innerHTML = aliases.map(alias => {
      const group = matches.filter(entry => identity(entry).remoteAlias === alias);
      if (!group.length) return '';
      const label = alias === null ? 'Local' : remoteHostLabel(alias, hosts);
      return `<section class="archived-group">
        <div class="archived-group-header"><button type="button" class="archived-group-toggle" role="button" aria-expanded="${!folded.has(alias)}" data-alias="${escapeHtml(alias || '')}" title="${escapeHtml(alias || 'Local')}"><span aria-hidden="true">${folded.has(alias) ? '▸' : '▾'}</span> <span class="archived-host-label">${escapeHtml(label)} (${group.length})</span></button>
        <label><input type="checkbox" class="archived-select-all" aria-label="Select all in ${escapeHtml(label)}" ${busy ? 'disabled' : ''}> Select all</label></div>
        <div class="archived-group-rows" ${folded.has(alias) ? 'hidden' : ''}>${group.map(entry => {
          const p = identity(entry), reasonId = 'archived-delete-reason-' + encodeURIComponent(entry);
          const folder = folders[entry], hasFolder = Object.hasOwn(folders, entry), hasProject = projectEntries.has(entry);
          const archivedAt = folder?.archivedAt ?? dates[entry];
          const date = typeof archivedAt === 'number' || typeof archivedAt === 'string' ? new Date(archivedAt) : null;
          return `<div class="archived-row" data-entry="${escapeHtml(entry)}">
            <input type="checkbox" class="archived-select" data-entry="${escapeHtml(entry)}" aria-label="Select ${escapeHtml(p.name)}" ${busy ? 'disabled' : ''}>
            <div class="archived-main"><div class="archived-name"><strong>${escapeHtml(p.name)}</strong> ${hasProject ? '<span class="archived-badge">Project</span>' : ''}${hasFolder ? ' <span class="archived-badge">Folder</span>' : ''}${hasProject && kinds[entry] === undefined ? ' <span class="archived-badge">legacy</span>' : ''}${alias ? ` <span class="archived-badge" title="${escapeHtml(label)}">${escapeHtml(alias)}</span>` : ''}</div>
            <div class="archived-path" title="${escapeHtml(p.projectPath)}">${escapeHtml(p.projectPath)}</div>
            <div class="archived-meta">${date && Number.isFinite(date.getTime()) ? `<time datetime="${date.toISOString()}">archived ${escapeHtml(date.toLocaleDateString())}</time>` : ''}${p.cached ? ` <span>${p.sessions.length} session${p.sessions.length === 1 ? '' : 's'}</span>` : ''}${Array.isArray(folder?.disabledSchedules) && folder.disabledSchedules.length > 0 ? ` <span>${folder.disabledSchedules.length} schedule${folder.disabledSchedules.length === 1 ? '' : 's'} off</span>` : ''}</div></div>
            <div class="archived-actions"><button type="button" class="settings-action-btn archived-unarchive" ${busy ? 'disabled' : ''}>Unarchive</button>
            <details class="archived-overflow"><summary aria-label="More actions for ${escapeHtml(p.name)}" aria-describedby="${escapeHtml(reasonId)}">⋯</summary><div class="archived-menu"><button type="button" class="settings-action-btn archived-copy">Copy path</button><button type="button" class="settings-action-btn archived-delete" ${busy ? 'disabled' : ''} aria-describedby="${escapeHtml(reasonId)}">Delete project…</button><span class="archived-delete-reason" id="${escapeHtml(reasonId)}"></span></div></details></div>
          </div>`;
        }).join('')}</div></section>`;
    }).join('');
    list.querySelectorAll('.archived-group-toggle').forEach(button => {
      const toggle = () => {
        const alias = button.dataset.alias || null;
        if (folded.has(alias)) folded.delete(alias); else folded.add(alias);
        button.setAttribute('aria-expanded', String(!folded.has(alias)));
        button.firstElementChild.textContent = folded.has(alias) ? '▸' : '▾';
        button.closest('.archived-group').querySelector('.archived-group-rows').hidden = folded.has(alias);
      };
      button.addEventListener('click', toggle);
      button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
      });
    });
    list.querySelectorAll('.archived-row').forEach(row => {
      const entry = row.dataset.entry;
      row.querySelector('.archived-select').addEventListener('change', event => {
        if (event.target.checked) selected.add(entry); else selected.delete(entry); selection();
      });
      row.querySelector('.archived-unarchive').addEventListener('click', event => restore([entry], event.currentTarget));
      row.querySelector('.archived-delete').addEventListener('click', event => remove(entry, event.currentTarget));
      row.querySelector('details').addEventListener('toggle', event => {
        const button = row.querySelector('.archived-delete');
        if (event.currentTarget.open && !busy && button.dataset.retryable === 'true') {
          button.dataset.unavailable = 'false'; button.disabled = false;
          row.querySelector('.archived-delete-reason').textContent = '';
        }
      });
      row.querySelector('.archived-copy').addEventListener('click', async event => {
        const button = event.currentTarget;
        try { await window.api.writeClipboard(identity(entry).projectPath); row.querySelector('details').open = false; row.querySelector('summary').focus(); }
        catch (error) { await fail('Could not copy path', [error.message], button); }
      });
      row.querySelector('details').addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary').focus(); event.stopPropagation(); }
      });
    });
    list.querySelectorAll('.archived-select-all').forEach(box => box.addEventListener('change', () => {
      box.closest('.archived-group').querySelectorAll('.archived-select').forEach(item => {
        if (box.checked) selected.add(item.dataset.entry); else selected.delete(item.dataset.entry);
      }); selection();
    }));
    selection();
  }
  function clearFilter() { filter.value = ''; render(); filter.focus(); }
  filter.addEventListener('input', render);
  filter.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); clearFilter(); } });
  bulk.addEventListener('click', () => restore([...selected], bulk));
  search.addEventListener('click', () => {
    const open = container.classList.toggle('archived-search-open'); search.setAttribute('aria-expanded', String(open));
    if (open) filter.focus();
  });
  render();
  const manager = {
    container,
    setHosts(next) { hosts = next; render(); },
    async refresh() {
      const [latest, folderArchives] = await Promise.all([window.api.getSetting('global'), window.api.getSetting('archivedProjects')]);
      kinds = { ...latest?.hiddenProjectKinds };
      dates = latest?.hiddenProjectArchivedAt || {};
      folders = { ...folderArchives };
      projectEntries = new Set((latest?.hiddenProjects || []).filter(entry => kinds[entry] !== 'delete'));
      archived = [...new Set([...projectEntries, ...Object.keys(folders)])].filter(entry => kinds[entry] !== 'delete');
      render();
    },
  };
  activeArchivedProjectsManager = manager;
  return manager;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderArchivedProjects };
