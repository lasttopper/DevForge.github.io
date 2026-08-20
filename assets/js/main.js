/* ============================================================
   VYROX — interactions
   Vanilla JS, progressive enhancement. All motion respects
   prefers-reduced-motion and heavy effects are desktop-only.
   ============================================================ */
(function () {
  "use strict";

  var CONFIG = window.SITE_CONFIG || {};
  var doc = document;

  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia("(pointer: fine)").matches;

  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  /* ---------- Apply site configuration ---------- */
  function applyConfig() {
    // Year
    var year = $("#year");
    if (year) year.textContent = String(new Date().getFullYear());

    // Brand name
    if (CONFIG.BRAND_NAME) {
      $all("[data-brand]").forEach(function (el) { el.textContent = CONFIG.BRAND_NAME; });
      doc.title = doc.title.replace(/^VYROX/, CONFIG.BRAND_NAME);
    }

    // WhatsApp links
    var waHref = "https://wa.me/" + String(CONFIG.WHATSAPP_NUMBER || "").replace(/\D/g, "");
    $all("[data-whatsapp]").forEach(function (el) { el.href = waHref; });

    // Email links
    if (CONFIG.EMAIL) {
      $all("[data-mailto]").forEach(function (el) { el.href = "mailto:" + CONFIG.EMAIL; el.textContent = CONFIG.EMAIL; });
    }

    // Socials
    var socials = { instagram: CONFIG.INSTAGRAM_URL, linkedin: CONFIG.LINKEDIN_URL, github: CONFIG.GITHUB_URL };
    $all("[data-social]").forEach(function (el) {
      var url = socials[el.getAttribute("data-social")];
      if (url) el.href = url;
    });
  }

  /* ---------- Navbar: glass on scroll ---------- */
  function initNavbar() {
    var navbar = $("#navbar");
    if (!navbar) return;
    var ticking = false;
    function update() {
      navbar.classList.toggle("scrolled", window.scrollY > 14);
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  /* ---------- Mobile menu ---------- */
  function initMobileMenu() {
    var burger = $("#navBurger");
    var menu = $("#mobileMenu");
    if (!burger || !menu) return;

    function setOpen(open) {
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      menu.classList.toggle("open", open);
      menu.setAttribute("aria-hidden", String(!open));
      doc.body.classList.toggle("menu-locked", open);
      if (open) {
        var first = $("nav a", menu);
        if (first) first.focus();
      } else {
        burger.focus();
      }
    }

    burger.addEventListener("click", function () {
      setOpen(burger.getAttribute("aria-expanded") !== "true");
    });

    $all("a", menu).forEach(function (link) {
      link.addEventListener("click", function () { setOpen(false); });
    });

    doc.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && burger.getAttribute("aria-expanded") === "true") setOpen(false);
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth >= 960 && burger.getAttribute("aria-expanded") === "true") setOpen(false);
    });
  }

  /* ---------- Scroll reveal ---------- */
  function initReveal() {
    var items = $all("[data-reveal]");
    if (!items.length) return;

    if (prefersReduced || !("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("in-view"); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });

    items.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Before / After slider ---------- */
  function initCompare() {
    var slider = $("#baSlider");
    var range = $("#baRange");
    if (!slider || !range) return;

    function paint() {
      slider.style.setProperty("--pos", range.value + "%");
      range.setAttribute("aria-valuetext", range.value + " percent");
    }
    range.addEventListener("input", paint);
    paint();
  }

  /* ---------- Process line ---------- */
  var processTrack = null;
  var processSteps = [];

  function initProcess() {
    processTrack = $("#processTrack");
    if (!processTrack) return;
    processSteps = $all(".step", processTrack);

    if (prefersReduced) {
      processTrack.style.setProperty("--progress", "1");
      processSteps.forEach(function (s) { s.classList.add("active"); });
      return;
    }
    processSteps.forEach(function (s) { s.classList.remove("active"); });
  }

  function updateProcess() {
    if (!processTrack || prefersReduced) return;
    var rect = processTrack.getBoundingClientRect();
    var vh = window.innerHeight;
    var progress = clamp((vh * 0.78 - rect.top) / (rect.height * 0.9), 0, 1);
    processTrack.style.setProperty("--progress", progress.toFixed(4));

    var positions = [0, 1 / 3, 2 / 3, 1];
    processSteps.forEach(function (step, i) {
      step.classList.toggle("active", progress >= positions[i] - 0.04);
    });
  }

  /* ---------- Subtle portfolio drift (parallax) ---------- */
  var driftEls = [];

  function initDrift() {
    if (prefersReduced || !finePointer) return;
    driftEls = $all("[data-drift]");
  }

  function updateDrift() {
    if (!driftEls.length || prefersReduced) return;
    var vh = window.innerHeight;
    driftEls.forEach(function (el) {
      var rect = el.getBoundingClientRect();
      if (rect.bottom < -80 || rect.top > vh + 80) return;
      var center = rect.top + rect.height / 2;
      var offset = ((center - vh / 2) / vh) * -8; // subtle, max ±8px
      el.style.setProperty("--drift", offset.toFixed(2) + "px");
    });
  }

  /* ---------- Unified scroll loop ---------- */
  function initScrollEffects() {
    var ticking = false;
    function frame() {
      updateProcess();
      updateDrift();
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(frame); }
    }, { passive: true });
    window.addEventListener("resize", frame, { passive: true });
    frame();
  }

  /* ---------- Hero mouse parallax (desktop only) ---------- */
  function initHeroParallax() {
    var hero = $("#home");
    var visual = $("#heroVisual");
    if (!hero || !visual || prefersReduced || !finePointer) return;

    var targetX = 0, targetY = 0, curX = 0, curY = 0;
    var rafId = null;

    function tick() {
      curX += (targetX - curX) * 0.08;
      curY += (targetY - curY) * 0.08;
      visual.style.transform = "translate3d(" + curX.toFixed(2) + "px," + curY.toFixed(2) + "px,0)";
      if (Math.abs(targetX - curX) > 0.05 || Math.abs(targetY - curY) > 0.05) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = null;
      }
    }

    hero.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "mouse") return;
      var rect = hero.getBoundingClientRect();
      targetX = ((e.clientX - rect.left) / rect.width - 0.5) * 18;
      targetY = ((e.clientY - rect.top) / rect.height - 0.5) * 12;
      if (!rafId) rafId = requestAnimationFrame(tick);
    });

    hero.addEventListener("pointerleave", function () {
      targetX = 0; targetY = 0;
      if (!rafId) rafId = requestAnimationFrame(tick);
    });
  }

  /* ---------- Magnetic buttons (desktop, subtle) ---------- */
  function initMagnetic() {
    if (prefersReduced || !finePointer) return;
    $all(".btn-magnetic").forEach(function (btn) {
      btn.addEventListener("pointermove", function (e) {
        if (e.pointerType !== "mouse") return;
        var rect = btn.getBoundingClientRect();
        var dx = ((e.clientX - rect.left) / rect.width - 0.5) * 8;
        var dy = ((e.clientY - rect.top) / rect.height - 0.5) * 6;
        btn.style.transform = "translate(" + dx.toFixed(1) + "px," + (dy.toFixed(1) - 2) + "px)";
      });
      btn.addEventListener("pointerleave", function () {
        btn.style.transform = "";
      });
    });
  }

  /* ---------- FAQ accordion (one open at a time) ---------- */
  function initFaq() {
    var items = $all(".faq-item");
    items.forEach(function (item) {
      var btn = $(".faq-q", item);
      if (!btn) return;
      btn.addEventListener("click", function () {
        var isOpen = item.classList.contains("open");
        items.forEach(function (other) {
          other.classList.remove("open");
          var b = $(".faq-q", other);
          if (b) b.setAttribute("aria-expanded", "false");
        });
        if (!isOpen) {
          item.classList.add("open");
          btn.setAttribute("aria-expanded", "true");
        }
      });
    });
  }

  /* ---------- Lead form ---------- */
  function initForm() {
    var form = $("#auditForm");
    if (!form) return;

    var submitBtn = $("#auditSubmit");
    var success = $("#formSuccess");
    var fallback = $("#formFallback");
    var submitting = false;

    var fields = {
      name: { el: $("#f-name"), err: $("#err-name") },
      business: { el: $("#f-business"), err: $("#err-business") },
      url: { el: $("#f-url"), err: $("#err-url") },
      contact: { el: $("#f-contact"), err: $("#err-contact") }
    };

    function setError(field, message) {
      field.err.textContent = message || "";
      field.el.setAttribute("aria-invalid", message ? "true" : "false");
    }

    function validWebsite(value) {
      var v = value.trim();
      if (/new\s*project/i.test(v)) return true; // "no website yet" path
      if (!/^https?:\/\//i.test(v)) v = "https://" + v;
      try {
        var u = new URL(v);
        return /\./.test(u.hostname) && u.hostname.length > 3;
      } catch (e) { return false; }
    }

    function validContact(value) {
      var v = value.trim();
      var email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
      if (email.test(v)) return true;
      var digits = v.replace(/\D/g, "");
      return /^[+\d\s().-]+$/.test(v) && digits.length >= 8 && digits.length <= 15;
    }

    function validate() {
      var ok = true;
      var firstBad = null;

      if (fields.name.el.value.trim().length < 2) {
        setError(fields.name, "Please tell us your name.");
        ok = false; firstBad = firstBad || fields.name.el;
      } else setError(fields.name, "");

      setError(fields.business, ""); // optional

      if (!fields.url.el.value.trim()) {
        setError(fields.url, "We need your website URL to review it.");
        ok = false; firstBad = firstBad || fields.url.el;
      } else if (!validWebsite(fields.url.el.value)) {
        setError(fields.url, "That doesn\u2019t look like a valid URL. Try something like yourbusiness.com");
        ok = false; firstBad = firstBad || fields.url.el;
      } else setError(fields.url, "");

      if (!fields.contact.el.value.trim()) {
        setError(fields.contact, "Add an email or WhatsApp number so we can reply.");
        ok = false; firstBad = firstBad || fields.contact.el;
      } else if (!validContact(fields.contact.el.value)) {
        setError(fields.contact, "Enter a valid email address or WhatsApp number.");
        ok = false; firstBad = firstBad || fields.contact.el;
      } else setError(fields.contact, "");

      if (firstBad) firstBad.focus();
      return ok;
    }

    // Clear errors while the user types
    Object.keys(fields).forEach(function (key) {
      fields[key].el.addEventListener("input", function () { setError(fields[key], ""); });
    });

    function showSuccess() {
      form.hidden = true;
      success.hidden = false;
      success.classList.add("play");
      fallback.textContent = "";
      success.focus();
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (submitting) return; // prevent duplicate submissions

      // Honeypot: silently "succeed" for bots
      var hp = $("#f-company");
      if (hp && hp.value) { showSuccess(); return; }

      if (!validate()) return;

      submitting = true;
      submitBtn.classList.add("loading");
      submitBtn.setAttribute("aria-busy", "true");
      submitBtn.disabled = true;
      fallback.textContent = "";

      var payload = {
        name: fields.name.el.value.trim(),
        business: fields.business.el.value.trim(),
        website: fields.url.el.value.trim(),
        contact: fields.contact.el.value.trim(),
        source: "website-audit",
        timestamp: new Date().toISOString()
      };

      function done() {
        submitBtn.classList.remove("loading");
        submitBtn.removeAttribute("aria-busy");
        showSuccess();
      }

      function fail() {
        submitting = false;
        submitBtn.classList.remove("loading");
        submitBtn.removeAttribute("aria-busy");
        submitBtn.disabled = false;
        fallback.textContent = "Something went wrong sending your request. Please try again, or email us directly.";
      }

      if (CONFIG.FORM_ENDPOINT) {
        // Real integration: POST to the configured backend / form service.
        fetch(CONFIG.FORM_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify(payload)
        })
          .then(function (res) {
            if (res.ok) done(); else fail();
          })
          .catch(fail);
      } else {
        // Preview mode: no endpoint configured — simulate a short
        // processing delay, then show the success state locally.
        window.setTimeout(done, 900);
      }
    });
  }

  /* ---------- Boot ---------- */
  function init() {
    applyConfig();
    initNavbar();
    initMobileMenu();
    initReveal();
    initCompare();
    initProcess();
    initDrift();
    initScrollEffects();
    initHeroParallax();
    initMagnetic();
    initFaq();
    initForm();
  }

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
