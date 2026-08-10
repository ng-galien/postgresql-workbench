const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealElements = document.querySelectorAll(".reveal");

if (reducedMotion || !("IntersectionObserver" in window)) {
  for (const element of revealElements) {
    element.classList.add("is-visible");
  }
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8%", threshold: 0.08 },
  );

  for (const element of revealElements) {
    observer.observe(element);
  }
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) {
      return;
    }

    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1600);
    } catch {
      button.textContent = "Select command";
    }
  });
}

const referenceFilter = document.querySelector("[data-filter-reference]");
if (referenceFilter) {
  const rows = document.querySelectorAll("[data-reference-row]");
  referenceFilter.addEventListener("input", () => {
    const query = referenceFilter.value.trim().toLocaleLowerCase();
    for (const row of rows) {
      row.hidden = query.length > 0 && !row.textContent.toLocaleLowerCase().includes(query);
    }
  });
}

const tocLinks = [...document.querySelectorAll(".page-toc a")];
if (tocLinks.length > 0 && "IntersectionObserver" in window) {
  const linksById = new Map(tocLinks.map((link) => [link.hash.slice(1), link]));
  const headings = [...linksById.keys()]
    .map((id) => document.getElementById(id))
    .filter((heading) => heading !== null);
  const sectionObserver = new IntersectionObserver(
    (entries) => {
      const current = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
      if (!current) {
        return;
      }
      for (const link of tocLinks) {
        link.classList.toggle("is-active", link === linksById.get(current.target.id));
      }
    },
    { rootMargin: "-18% 0px -70%", threshold: 0 },
  );
  for (const heading of headings) {
    sectionObserver.observe(heading);
  }
}
