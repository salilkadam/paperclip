/* motion-explainer-studio scene engine.
 *
 * Everything here is a PURE function of t. The renderer seeks rather than plays,
 * so an effect that accumulates state (`n += 1` on each tick) would render
 * differently depending on how many frames happened to be drawn. Given the same
 * t, seek() must always produce the same DOM.
 *
 * Declarative hooks, all optional:
 *   data-count-to="1200" data-count-from="0" data-at="0.4" data-dur="1.4"
 *                        data-prefix="$" data-suffix="%" data-dp="0" data-comma="1"
 *   data-type="Hello world"  data-at="0.3" data-dur="1.2"       typewriter
 *   data-progress="72"       data-at="0.5" data-dur="1.0"       width in %
 *   data-stagger            on a parent: auto-assigns --i to children
 */
(function () {
  var EASE = function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

  function phase(el, t) {
    var at = parseFloat(el.dataset.at || '0');
    var dur = parseFloat(el.dataset.dur || '1');
    if (dur <= 0) return t >= at ? 1 : 0;
    return Math.max(0, Math.min(1, (t - at) / dur));
  }

  function fmt(v, el) {
    var dp = parseInt(el.dataset.dp || '0', 10);
    var s = v.toFixed(dp);
    if (el.dataset.comma === '1') {
      var parts = s.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      s = parts.join('.');
    }
    return (el.dataset.prefix || '') + s + (el.dataset.suffix || '');
  }

  function stagger() {
    document.querySelectorAll('[data-stagger]').forEach(function (p) {
      var base = parseFloat(p.dataset.stagger) || 0;
      Array.prototype.forEach.call(p.children, function (c, i) {
        if (!c.style.getPropertyValue('--i')) c.style.setProperty('--i', String(i + base));
      });
    });
  }

  window.MES = {
    seek: function (t) {
      document.querySelectorAll('[data-count-to]').forEach(function (el) {
        var a = parseFloat(el.dataset.countFrom || '0');
        var b = parseFloat(el.dataset.countTo);
        el.textContent = fmt(a + (b - a) * EASE(phase(el, t)), el);
      });
      document.querySelectorAll('[data-type]').forEach(function (el) {
        var full = el.dataset.type;
        var n = Math.round(full.length * phase(el, t));
        el.textContent = full.slice(0, n);
      });
      document.querySelectorAll('[data-progress]').forEach(function (el) {
        var target = parseFloat(el.dataset.progress);
        el.style.width = (target * EASE(phase(el, t))).toFixed(2) + '%';
      });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { stagger(); window.MES.seek(0); });
  } else {
    stagger();
    window.MES.seek(0);
  }
})();
