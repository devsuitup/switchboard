// Drag-to-resize handle shared by the renderer's splitters.
// see .ai/contexts/panel-terminal.md ("The third splitter")

// handle: the element the user grabs.
// opts.axis: 'x' (horizontal drag) or 'y' (vertical drag).
// opts.getSize: () => the size being resized, read at mousedown.
// opts.onDrag: (sizeAtMouseDown, delta) => void, delta positive right/down.
// opts.onCommit: () => void, called once on mouseup.
function createSplitter(handle, opts) {
  if (!handle || !opts || typeof opts.getSize !== 'function' || typeof opts.onDrag !== 'function') return null;
  const vertical = opts.axis === 'y';
  const cursor = vertical ? 'row-resize' : 'col-resize';
  let start = 0;
  let startSize = 0;

  const coordOf = (e) => (vertical ? e.clientY : e.clientX);

  function onMouseMove(e) {
    opts.onDrag(startSize, coordOf(e) - start);
  }

  function onMouseUp() {
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    if (typeof opts.onCommit === 'function') opts.onCommit();
  }

  function onMouseDown(e) {
    e.preventDefault();
    start = coordOf(e);
    startSize = opts.getSize();
    handle.classList.add('dragging');
    document.body.style.cursor = cursor;
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  handle.addEventListener('mousedown', onMouseDown);
  return { destroy: () => handle.removeEventListener('mousedown', onMouseDown) };
}
