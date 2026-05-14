import { describe, expect, it } from "vitest";

const tsxFiles = import.meta.glob("./**/*.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

function startTags(source: string, tagName: string): string[] {
  const tags: string[] = [];
  let index = 0;
  const prefix = `<${tagName}`;

  while ((index = source.indexOf(prefix, index)) !== -1) {
    const nextChar = source[index + prefix.length];
    if (nextChar && !/[\s>/]/.test(nextChar)) {
      index += prefix.length;
      continue;
    }
    let end = index + prefix.length;
    while (end < source.length) {
      if (source[end] === ">" && source[end - 1] !== "=" && source[end + 1] !== "=") {
        break;
      }
      end += 1;
    }
    tags.push(source.slice(index, end + 1));
    index = end + 1;
  }

  return tags;
}

function buttonStartTags(source: string): string[] {
  return startTags(source, "button");
}

function attrValue(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1] ?? null;
}

function attrExpression(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\b${name}=\\{([^}]+)\\}`))?.[1]?.trim() ?? null;
}

describe("accessibility semantics", () => {
  it("uses explicit button types for every interactive button", () => {
    const missingTypes = Object.entries(tsxFiles).flatMap(([path, source]) =>
      buttonStartTags(source)
        .filter((tag) => !/\btype=/.test(tag))
        .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`),
    );

    expect(missingTypes).toEqual([]);
  });

  it("pairs disclosure state with a controlled region", () => {
    const missingControls = Object.entries(tsxFiles).flatMap(([path, source]) => {
      const controlledTargetTags = startTags(source, "textarea")
        .concat(startTags(source, "div"), startTags(source, "section"), startTags(source, "pre"), startTags(source, "tr"));
      const ids = new Set(controlledTargetTags
        .map((tag) => attrValue(tag, "id"))
        .filter((value): value is string => value !== null));
      const idExpressions = new Set(controlledTargetTags
        .map((tag) => attrExpression(tag, "id"))
        .filter((value): value is string => value !== null));

      return buttonStartTags(source)
        .filter((tag) => /\baria-expanded=/.test(tag))
        .filter((tag) => {
          const controlledId = attrValue(tag, "aria-controls");
          const controlledExpression = attrExpression(tag, "aria-controls");
          if (controlledId) return !ids.has(controlledId);
          if (controlledExpression) return !idExpressions.has(controlledExpression);
          return true;
        })
        .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`);
    });

    expect(missingControls).toEqual([]);
  });

  it("keeps markdown export fields read-only", () => {
    const writableExports = Object.entries(tsxFiles).flatMap(([path, source]) =>
      startTags(source, "textarea")
        .filter((tag) => /markdown-export/.test(tag))
        .filter((tag) => !/\breadOnly\b/.test(tag))
        .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`),
    );

    expect(writableExports).toEqual([]);
  });

  it("exposes active button state semantically", () => {
    const activeWithoutState = Object.entries(tsxFiles).flatMap(([path, source]) =>
      buttonStartTags(source)
        .filter((tag) => /active/.test(tag) && !/\baria-current=/.test(tag) && !/\baria-pressed=/.test(tag))
        .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`),
    );

    expect(activeWithoutState).toEqual([]);
  });

  it("names form controls explicitly", () => {
    const unnamedControls = Object.entries(tsxFiles).flatMap(([path, source]) =>
      ["input", "select", "textarea"].flatMap((tagName) =>
        startTags(source, tagName)
          .filter((tag) => !/\baria-label=/.test(tag) && !/\baria-labelledby=/.test(tag))
          .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`),
      ),
    );

    expect(unnamedControls).toEqual([]);
  });

  it("scopes table headers", () => {
    const unscopedHeaders = Object.entries(tsxFiles).flatMap(([path, source]) =>
      startTags(source, "th")
        .filter((tag) => !/\bscope=/.test(tag))
        .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`),
    );

    expect(unscopedHeaders).toEqual([]);
  });

  it("names data tables", () => {
    const unnamedTables = Object.entries(tsxFiles).flatMap(([path, source]) =>
      startTags(source, "table")
        .filter((tag) => !/\baria-label=/.test(tag) && !/\baria-labelledby=/.test(tag))
        .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`),
    );

    expect(unnamedTables).toEqual([]);
  });

  it("names page landmarks and keeps a single main landmark", () => {
    const unnamedLandmarks = Object.entries(tsxFiles).flatMap(([path, source]) =>
      ["aside", "main", "nav"].flatMap((tagName) =>
        startTags(source, tagName)
          .filter((tag) => !/\baria-label=/.test(tag) && !/\baria-labelledby=/.test(tag))
          .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`),
      ),
    );
    const mainLandmarks = Object.values(tsxFiles).flatMap((source) => startTags(source, "main"));

    expect(unnamedLandmarks).toEqual([]);
    expect(mainLandmarks).toHaveLength(1);
  });

  it("provides a skip link to the main content", () => {
    const tags = Object.values(tsxFiles).flatMap((source) => startTags(source, "a"));
    const mainLandmarks = Object.values(tsxFiles).flatMap((source) => startTags(source, "main"));

    expect(mainLandmarks.some((tag) => /\bid="dashboard-main"/.test(tag) && /\btabIndex=\{-1\}/.test(tag))).toBe(true);
    expect(tags.some((tag) => /\bhref="#dashboard-main"/.test(tag))).toBe(true);
  });

  it("uses safe rel values for new-tab links", () => {
    const unsafeLinks = Object.entries(tsxFiles).flatMap(([path, source]) =>
      startTags(source, "a")
        .filter((tag) => /\btarget="_blank"/.test(tag) && !/\brel="[^"]*(noreferrer|noopener)[^"]*"/.test(tag))
        .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`),
    );

    expect(unsafeLinks).toEqual([]);
  });

  it("routes dynamic new-tab hrefs through an external URL sanitizer", () => {
    const unsafeDynamicLinks = Object.entries(tsxFiles).flatMap(([path, source]) =>
      startTags(source, "a")
        .filter((tag) => /\btarget="_blank"/.test(tag))
        .filter((tag) => /\bhref=\{/.test(tag))
        .filter((tag) => !source.includes("safeExternalHref"))
        .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`),
    );

    expect(unsafeDynamicLinks).toEqual([]);
  });

  it("does not inject API supplied markup into the React DOM", () => {
    const rawMarkupInjection = Object.entries(tsxFiles)
      .filter(([, source]) => source.includes("dangerouslySetInnerHTML"))
      .map(([path]) => path);

    expect(rawMarkupInjection).toEqual([]);
  });

  it("redacts raw JSON debug panels before rendering them", () => {
    const unsafeRawJsonPanels = Object.entries(tsxFiles).flatMap(([path, source]) =>
      source
        .match(/<pre className="json-block">\{JSON\.stringify\([^}]+\)\}<\/pre>/g)
        ?.map((match) => `${path}: ${match}`) ?? [],
    );

    expect(unsafeRawJsonPanels).toEqual([]);
  });

  it("guards API-supplied detail navigation ids before routing", () => {
    const routeParamNavigation = /dashboardRoutes\.(run|trace)\(runId\)/;
    const unguardedDynamicNavigation = Object.entries(tsxFiles).flatMap(([path, source]) =>
      buttonStartTags(source)
        .filter((tag) => /dashboardRoutes\.(card|run|trace)\(/.test(tag))
        .filter((tag) => !/\bdisabled=/.test(tag))
        .filter((tag) => !routeParamNavigation.test(tag))
        .map((tag) => `${path}: ${tag.replace(/\s+/g, " ")}`),
    );

    expect(unguardedDynamicNavigation).toEqual([]);
  });

  it("does not use bare API ids as React keys for mutable rows", () => {
    const bareApiKeys = Object.entries(tsxFiles).flatMap(([path, source]) =>
      source
        .match(/key=\{(?:event|item|run)\.id\}/g)
        ?.map((match) => `${path}: ${match}`) ?? [],
    );

    expect(bareApiKeys).toEqual([]);
  });

  it("does not use backend text values as bare React keys", () => {
    const bareTextKeys = Object.entries(tsxFiles).flatMap(([path, source]) =>
      source
        .match(/key=\{(?:source|highlight|chip|item|kind)\}/g)
        ?.map((match) => `${path}: ${match}`) ?? [],
    );

    expect(bareTextKeys).toEqual([]);
  });

  it("does not compose React keys from backend text values", () => {
    const backendTextKeyPatterns = [
      /key=\{`[^`]*\$\{(?:source|highlight|chip|item)\}[^`]*`\}/g,
      /key=\{`[^`]*\$\{action\.label\}[^`]*`\}/g,
      /key=\{`[^`]*\$\{valueText\([^`]*`\}/g,
    ];
    const composedTextKeys = Object.entries(tsxFiles).flatMap(([path, source]) =>
      backendTextKeyPatterns.flatMap((pattern) =>
        source.match(pattern)?.map((match) => `${path}: ${match}`) ?? [],
      ),
    );

    expect(composedTextKeys).toEqual([]);
  });

  it("does not derive React keys from card titles", () => {
    const titleDerivedKeys = Object.entries(tsxFiles).flatMap(([path, source]) =>
      source
        .match(/key=\{[^}]*cardTitle\(/g)
        ?.map((match) => `${path}: ${match}`) ?? [],
    );

    expect(titleDerivedKeys).toEqual([]);
  });
});
