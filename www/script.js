/* =========================================
   Klaudii Marketing Site — script.js
   ========================================= */

// ---- Typing animation in hero terminal ----
(function heroTerminal() {
  const cmd = 'curl -fsSL https://klaudii.com/setup.sh | bash';
  const cmdEl = document.getElementById('typed-cmd');
  const cursorEl = document.getElementById('cursor');
  const outputEl = document.getElementById('terminal-output');
  if (!cmdEl) return;

  const outputLines = [
    { text: '', delay: 400 },
    { text: '<span class="line-check">&#10003;</span> Checking dependencies...', delay: 600 },
    { text: '<span class="line-check">&#10003;</span> Node.js 22.1.0 found', delay: 400 },
    { text: '<span class="line-check">&#10003;</span> Installing tmux and ttyd via Homebrew', delay: 800 },
    { text: '<span class="line-check">&#10003;</span> Creating config at ~/.klaudii/config.json', delay: 500 },
    { text: '<span class="line-check">&#10003;</span> Registering launchd agent (auto-start on login)', delay: 600 },
    { text: '<span class="line-check">&#10003;</span> Compiling menu bar app', delay: 500 },
    { text: '', delay: 200 },
    { text: '<span class="line-arrow">&#10148;</span> Klaudii is running at <strong style="color:#e4e4ed">http://localhost:9876</strong>', delay: 0 },
  ];

  let charIndex = 0;

  function typeChar() {
    if (charIndex < cmd.length) {
      cmdEl.textContent += cmd[charIndex];
      charIndex++;
      setTimeout(typeChar, 25 + Math.random() * 35);
    } else {
      cursorEl.style.display = 'none';
      showOutput(0);
    }
  }

  function showOutput(lineIndex) {
    if (lineIndex >= outputLines.length) return;
    const line = outputLines[lineIndex];
    const div = document.createElement('div');
    div.innerHTML = line.text;
    div.style.opacity = '0';
    div.style.transition = 'opacity 0.3s ease';
    outputEl.appendChild(div);
    requestAnimationFrame(() => {
      div.style.opacity = '1';
    });
    setTimeout(() => showOutput(lineIndex + 1), line.delay);
  }

  // Start after a brief pause
  setTimeout(typeChar, 800);
})();


// ---- Scroll-based fade-in animations ----
(function scrollAnimations() {
  // Tag elements for animation
  const selectors = [
    '.feature-block',
    '.security-card',
    '.e2e-diagram',
    '.setup-step',
    '.pricing-card',
    '.arch-layer',
    '.stats-band .stat',
    '.mock-extension',
  ];

  selectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      el.classList.add('fade-in');
    });
  });

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.15,
    rootMargin: '0px 0px -40px 0px'
  });

  document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
})();


// ---- Mobile nav toggle ----
(function mobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const menu = document.getElementById('nav-mobile');
  if (!toggle || !menu) return;

  toggle.addEventListener('click', () => {
    menu.classList.toggle('open');
  });

  // Close on link click
  menu.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => menu.classList.remove('open'));
  });
})();


// ---- Copy install command ----
function copyInstall() {
  const text = 'curl -fsSL https://klaudii.com/setup.sh | bash';
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
}


// ---- Smooth scroll for anchor links ----
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', (e) => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      const offset = 80; // nav height
      const y = target.getBoundingClientRect().top + window.pageYOffset - offset;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  });
});


// ---- Nav background on scroll ----
(function navScroll() {
  const nav = document.getElementById('nav');
  if (!nav) return;

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        if (window.scrollY > 100) {
          nav.style.background = 'rgba(10,10,15,0.95)';
        } else {
          nav.style.background = 'rgba(10,10,15,0.8)';
        }
        ticking = false;
      });
      ticking = true;
    }
  });
})();


// ---- Stretchy nav indicator ----
(function navIndicator() {
  const container = document.getElementById('nav-links');
  const indicator = document.getElementById('nav-indicator');
  if (!container || !indicator) return;

  const links = container.querySelectorAll('a[data-section]');
  const sections = [];
  links.forEach(link => {
    const id = link.dataset.section;
    const section = document.getElementById(id);
    if (section) sections.push({ link, section, id });
  });
  if (!sections.length) return;

  let current = null;

  function moveIndicator(link) {
    if (!link) {
      indicator.style.opacity = '0';
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    indicator.style.opacity = '1';
    indicator.style.left = (linkRect.left - containerRect.left) + 'px';
    indicator.style.width = linkRect.width + 'px';
  }

  function updateActive() {
    const scrollY = window.scrollY + 120; // offset for nav
    let active = null;

    for (let i = sections.length - 1; i >= 0; i--) {
      const top = sections[i].section.offsetTop;
      if (scrollY >= top) {
        active = sections[i];
        break;
      }
    }

    // Hide if at the very top (hero area)
    if (window.scrollY < 300) active = null;

    if (active !== current) {
      if (current) current.link.classList.remove('active');
      current = active;
      if (current) {
        current.link.classList.add('active');
        moveIndicator(current.link);
      } else {
        moveIndicator(null);
      }
    }
  }

  // Stretch effect: briefly widen during transition
  let prevLeft = 0;
  const origTransition = indicator.style.transition;
  const observer = new MutationObserver(() => {
    const newLeft = parseFloat(indicator.style.left) || 0;
    if (Math.abs(newLeft - prevLeft) > 10) {
      const stretch = Math.min(Math.abs(newLeft - prevLeft) * 0.3, 40);
      indicator.style.transition = 'left 0.35s cubic-bezier(0.4,0,0.2,1), width 0.35s cubic-bezier(0.4,0,0.2,1)';
      // Temporarily widen
      const baseWidth = parseFloat(indicator.style.width) || 0;
      indicator.style.width = (baseWidth + stretch) + 'px';
      setTimeout(() => {
        if (current) moveIndicator(current.link);
      }, 180);
    }
    prevLeft = newLeft;
  });
  observer.observe(indicator, { attributes: true, attributeFilter: ['style'] });

  indicator.style.opacity = '0';

  let rafId;
  window.addEventListener('scroll', () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(updateActive);
  });

  // Also update on resize (link positions change)
  window.addEventListener('resize', () => {
    if (current) moveIndicator(current.link);
  });
})();
