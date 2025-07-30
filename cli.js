#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { load, dump } from "js-yaml";
import { dereferenceSync } from "@trojs/openapi-dereference";
import { resolve } from "path";

/**
 * Find referenced schemas in a JSON object
 */
function findRefs(json, refs, refPrefix = "#/components/schemas/") {
  if (!refs) return [];

  const string = JSON.stringify(json, undefined, 0);
  const refsIncluded = Object.keys(refs).filter((refKey) => {
    const snippet = `"$ref":"${refPrefix}${refKey}"`;
    return string.includes(snippet);
  });
  return refsIncluded;
}

/**
 * Create a subset of OpenAPI document with only the needed components
 */
function createSubset(openapi, paths, operationFilter = null) {
  const subset = {
    openapi: openapi.openapi,
    info: openapi.info,
    servers: openapi.servers,
    paths: {},
  };

  // Add filtered paths
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    const filteredPathItem = {};
    const methods = [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
      "trace",
    ];

    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation) continue;

      if (operationFilter && !operationFilter(operation, method, path))
        continue;

      filteredPathItem[method] = operation;
    }

    if (Object.keys(filteredPathItem).length > 0) {
      subset.paths[path] = filteredPathItem;
    }
  }

  // Find and include only referenced components
  const neededRefs = findRefs(subset, openapi.components?.schemas);

  if (neededRefs.length > 0 && openapi.components?.schemas) {
    subset.components = { schemas: {} };
    for (const refName of neededRefs) {
      if (openapi.components.schemas[refName]) {
        subset.components.schemas[refName] =
          openapi.components.schemas[refName];
      }
    }
  }

  // Include other components if they exist and are referenced
  if (openapi.components) {
    const componentTypes = [
      "parameters",
      "responses",
      "examples",
      "requestBodies",
      "headers",
      "securitySchemes",
      "links",
      "callbacks",
    ];

    for (const componentType of componentTypes) {
      if (openapi.components[componentType]) {
        const componentRefs = findRefs(
          subset,
          openapi.components[componentType],
          `#/components/${componentType}/`
        );
        if (componentRefs.length > 0) {
          if (!subset.components) subset.components = {};
          subset.components[componentType] = {};
          for (const refName of componentRefs) {
            subset.components[componentType][refName] =
              openapi.components[componentType][refName];
          }
        }
      }
    }
  }

  return subset;
}

/**
 * Generate SLOP (overview) content
 */
function generateSlop(openapi) {
  const operations = [];
  const tagGroups = {};

  // Collect all operations and group by tags
  for (const [path, pathItem] of Object.entries(openapi.paths || {})) {
    if (!pathItem || typeof pathItem !== "object") continue;

    const methods = [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
      "trace",
    ];

    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation) continue;

      const operationId =
        operation.operationId ||
        `${path.slice(1).replace(/[^a-zA-Z0-9]/g, "_")}_${method}`;
      const tags = operation.tags || ["untagged"];

      const operationInfo = {
        operationId,
        method: method.toUpperCase(),
        path,
        summary: operation.summary || "",
        description: operation.description || "",
        tags,
      };

      operations.push(operationInfo);

      // Group by tags
      for (const tag of tags) {
        if (!tagGroups[tag]) {
          tagGroups[tag] = [];
        }
        tagGroups[tag].push(operationInfo);
      }
    }
  }

  // Generate SLOP content
  let slop = `# ${openapi.info?.title || "API"} Operations\n\n`;

  if (openapi.info?.description) {
    slop += `${openapi.info.description}\n\n`;
  }

  slop += `Version: ${openapi.info?.version || "unknown"}\n\n`;

  // Add overview
  slop += `## Overview\n\n`;
  slop += `This API contains ${operations.length} operations`;

  const tagCount = Object.keys(tagGroups).length;
  if (tagCount > 1 || (tagCount === 1 && !tagGroups.untagged)) {
    slop += ` grouped into ${tagCount} categories`;
  }
  slop += `.\n\n`;

  // List operations by tag
  for (const [tag, tagOperations] of Object.entries(tagGroups)) {
    if (tag === "untagged" && Object.keys(tagGroups).length > 1) {
      slop += `## Untagged Operations\n\n`;
    } else if (tag !== "untagged") {
      slop += `## ${tag}\n\n`;
      slop += `[View ${tag} operations](tags/${tag}.yaml)\n\n`;
    }

    for (const op of tagOperations) {
      slop += `### ${op.operationId}\n\n`;
      slop += `**${op.method} ${op.path}**\n\n`;

      if (op.summary) {
        slop += `${op.summary}\n\n`;
      }

      if (op.description && op.description !== op.summary) {
        slop += `${op.description}\n\n`;
      }

      slop += `[View operation details](operations/${op.operationId}.yaml)\n\n`;
      slop += `---\n\n`;
    }
  }

  return slop;
}

/**
 * Process OpenAPI document and generate all files
 */
function processOpenAPI(openapi) {
  const files = {};

  try {
    // Dereference the OpenAPI document for processing
    const dereferenced = dereferenceSync(openapi);

    // Generate main SLOP
    files["SLOP.md"] = { content: generateSlop(dereferenced) };

    // Collect operations and tags
    const operations = [];
    const tags = new Set();

    for (const [path, pathItem] of Object.entries(dereferenced.paths || {})) {
      if (!pathItem || typeof pathItem !== "object") continue;

      const methods = [
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
        "trace",
      ];

      for (const method of methods) {
        const operation = pathItem[method];
        if (!operation) continue;

        const operationId =
          operation.operationId ||
          `${path.slice(1).replace(/[^a-zA-Z0-9]/g, "_")}_${method}`;
        const operationTags = operation.tags || [];

        operations.push({
          operationId,
          path,
          method,
          operation,
          tags: operationTags,
        });

        operationTags.forEach((tag) => tags.add(tag));
      }
    }

    // Generate operation files
    for (const { operationId, path, method, operation } of operations) {
      const operationSubset = createSubset(
        openapi, // Use original openapi to preserve refs
        { [path]: { [method]: operation } }
      );

      files[`operations/${operationId}.yaml`] = {
        content: dump(operationSubset, { noRefs: true, indent: 2 }),
      };
    }

    // Generate tag files
    for (const tag of tags) {
      const tagPaths = {};

      for (const [path, pathItem] of Object.entries(openapi.paths || {})) {
        if (!pathItem || typeof pathItem !== "object") continue;

        const methods = [
          "get",
          "post",
          "put",
          "patch",
          "delete",
          "head",
          "options",
          "trace",
        ];
        const filteredPathItem = {};

        for (const method of methods) {
          const operation = pathItem[method];
          if (!operation) continue;

          if (operation.tags?.includes(tag)) {
            filteredPathItem[method] = operation;
          }
        }

        if (Object.keys(filteredPathItem).length > 0) {
          tagPaths[path] = filteredPathItem;
        }
      }

      if (Object.keys(tagPaths).length > 0) {
        const tagSubset = createSubset(openapi, tagPaths);
        files[`tags/${tag}.yaml`] = {
          content: dump(tagSubset, { noRefs: true, indent: 2 }),
        };
      }
    }

    // Handle untagged operations
    const untaggedPaths = {};
    for (const [path, pathItem] of Object.entries(openapi.paths || {})) {
      if (!pathItem || typeof pathItem !== "object") continue;

      const methods = [
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
        "trace",
      ];
      const filteredPathItem = {};

      for (const method of methods) {
        const operation = pathItem[method];
        if (!operation) continue;

        if (!operation.tags || operation.tags.length === 0) {
          filteredPathItem[method] = operation;
        }
      }

      if (Object.keys(filteredPathItem).length > 0) {
        untaggedPaths[path] = filteredPathItem;
      }
    }

    if (Object.keys(untaggedPaths).length > 0) {
      const untaggedSubset = createSubset(openapi, untaggedPaths);
      files["tags/untagged.yaml"] = {
        content: dump(untaggedSubset, { noRefs: true, indent: 2 }),
      };
    }
  } catch (error) {
    console.error("Error processing OpenAPI:", error.message);
    process.exit(1);
  }

  return files;
}

/**
 * CLI functionality
 */
function runCLI() {
  const cwd = process.cwd();

  // Look for OpenAPI file
  let openapiFile = null;
  let openapiContent = null;

  if (existsSync(resolve(cwd, "openapi.json"))) {
    openapiFile = "openapi.json";
    openapiContent = JSON.parse(
      readFileSync(resolve(cwd, openapiFile), "utf8")
    );
  } else if (existsSync(resolve(cwd, "openapi.yaml"))) {
    openapiFile = "openapi.yaml";
    openapiContent = load(readFileSync(resolve(cwd, openapiFile), "utf8"));
  } else if (existsSync(resolve(cwd, "openapi.yml"))) {
    openapiFile = "openapi.yml";
    openapiContent = load(readFileSync(resolve(cwd, openapiFile), "utf8"));
  } else {
    console.error(
      "No openapi.json, openapi.yaml, or openapi.yml found in current directory"
    );
    process.exit(1);
  }

  console.log(`Found ${openapiFile}, processing...`);

  // Process the OpenAPI document
  const files = processOpenAPI(openapiContent);

  // Write all files
  for (const [filePath, fileData] of Object.entries(files)) {
    const fullPath = resolve(cwd, filePath);
    const dir = resolve(fullPath, "..");

    // Create directory if it doesn't exist
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(fullPath, fileData.content, "utf8");
    console.log(`Created: ${filePath}`);
  }

  console.log(
    `\nGenerated ${Object.keys(files).length} files from ${openapiFile}`
  );
  console.log("Main overview available in SLOP.md");
}

// Export the function for programmatic use
export { processOpenAPI };

// Run CLI if this file is executed directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  runCLI();
}
