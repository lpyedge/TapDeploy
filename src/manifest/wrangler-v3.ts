import { parse, type ParseError } from "jsonc-parser";

import { WRANGLER_V3_FIELD_MATRIX } from "./wrangler-v3-schema.js";
import type {
  WranglerV3Kind,
  WranglerV3Issue,
  WranglerV3Route,
  WranglerV3Workflow,
  WranglerV3DurableObjectBinding,
  WranglerV3Migration,
  WranglerV3ServiceBinding,
  WranglerV3Rule,
  WranglerV3Assets,
  WranglerV3Config,
  WranglerV3Result,
  WranglerV3Options,
} from "./wrangler-v3-schema.js";
import {
  UNCOMPILED_EXTENSIONS,
  ESM_EXTENSIONS,
  HTML_HANDLING,
  NOT_FOUND_HANDLING,
  ASSET_KEYS,
  ROUTE_KEYS,
  TRIGGER_KEYS,
  WORKFLOW_KEYS,
  WORKFLOW_REFUSED_KEYS,
  DURABLE_OBJECT_KEYS,
  SERVICE_KEYS,
  SERVICE_REFUSED_KEYS,
  RULE_KEYS,
  isPlainObject,
  isNonEmptyString,
  isStringArray,
  extensionOf,
  checkKnownKeys,
  checkEntryKeys,
  resolveZipRelativePath,
} from "./wrangler-v3-keys.js";
import {
  normalizeAccountResourceBindings,
  normalizePlatformBindings,
  normalizeQueues,
  normalizeRateLimits,
} from "./wrangler-v3-resources.js";

// ---------------------------------------------------------------------------
// V3 final Wrangler-config normalization.
//
// The ZIP carries the FINAL, already-built `wrangler.jsonc` (per unit). This
// module parses it strictly (JSONC) and normalizes it into a deployment
// description that later tasks consume. Rules:
//
//   - Never run anything from the config: no `build.command`, no scripts, no
//     eval. `build` is accepted as documentation only and recorded inert.
//   - Entry paths (`main`, `assets.directory`, `pages_build_output_dir`) are
//     resolved relative to the unit's config location inside the ZIP and must
//     not escape the ZIP root.
//   - `main` must point to built ESM JS (.js/.mjs). TypeScript sources fail
//     with UNCOMPILED_ENTRYPOINT: the browser never compiles.
//   - Every official Wrangler field has one of three matrix states:
//       supported   -> parsed + normalized into the result
//       inert       -> reviewed allowlist, accepted and recorded in inertFields
//       unsupported -> UNSUPPORTED_WRANGLER_FEATURE (fail closed, clear error)
//     Anything not in the matrix is UNKNOWN_WRANGLER_FIELD (never silently
//     dropped: an unrecognized deployment field must fail the parse).
//   - "unsupported" here means "not implemented by TapDeploy", not
//     "invalid Wrangler".
//   - Typed bindings stay typed: R2/D1/KV/workflow/DO/service bindings are
//     never flattened into `vars`/process.env.
// ---------------------------------------------------------------------------

export * from "./wrangler-v3-schema.js";

export function normalizeWranglerV3(
  source: string,
  options: WranglerV3Options = {},
): WranglerV3Result {
  const issues: WranglerV3Issue[] = [];
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    return {
      ok: false,
      issues: [
        {
          code: "INVALID_JSONC",
          field: "(root)",
          detail: `wrangler config is not valid JSONC (${errors.length} parse error(s))`,
        },
      ],
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      issues: [
        {
          code: "INVALID_SHAPE",
          field: "(root)",
          detail: "wrangler config must be a JSON object",
        },
      ],
    };
  }

  const configPath = options.configPath ?? "wrangler.jsonc";
  const baseDir = configPath.includes("/")
    ? configPath.slice(0, configPath.lastIndexOf("/"))
    : "";

  // ---- Top-level field matrix pass ----------------------------------------
  const inertFields: string[] = [];
  for (const key of Object.keys(parsed)) {
    const status = WRANGLER_V3_FIELD_MATRIX[key];
    if (status === "supported") {
      continue;
    }
    if (status === "inert") {
      inertFields.push(key);
      continue;
    }
    if (status === "unsupported") {
      issues.push({
        code: "UNSUPPORTED_WRANGLER_FEATURE",
        field: key,
        detail: `official Wrangler field "${key}" is not implemented by the TapDeploy V3 pipeline yet; refusing to ignore it`,
      });
      continue;
    }
    issues.push({
      code: "UNKNOWN_WRANGLER_FIELD",
      field: key,
      detail: `"${key}" is not a recognized Wrangler config field; refusing to ignore it`,
    });
  }

  // `build` is documentation only (never executed). Legacy `build.upload`
  // format selection is deployment-affecting and is refused.
  const build = parsed["build"];
  if (isPlainObject(build) && build["upload"] !== undefined) {
    issues.push({
      code: "UNSUPPORTED_WRANGLER_FEATURE",
      field: "build.upload",
      detail:
        "legacy build.upload is not supported; V3 uploads prebuilt ESM modules",
    });
  }

  // ---- name / compatibility ------------------------------------------------
  const name = parsed["name"];
  if (!isNonEmptyString(name)) {
    issues.push({
      code: "INVALID_SHAPE",
      field: "name",
      detail: "name must be a non-empty string",
    });
  }

  const compatibilityDate = parsed["compatibility_date"];
  if (!isNonEmptyString(compatibilityDate)) {
    issues.push({
      code: "INVALID_SHAPE",
      field: "compatibility_date",
      detail: "compatibility_date is required and must be a string",
    });
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) {
    issues.push({
      code: "INVALID_SHAPE",
      field: "compatibility_date",
      detail: "compatibility_date must use the YYYY-MM-DD format",
    });
  }

  let compatibilityFlags: string[] = [];
  const rawCompatFlags = parsed["compatibility_flags"];
  if (rawCompatFlags !== undefined) {
    if (!isStringArray(rawCompatFlags)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "compatibility_flags",
        detail: "compatibility_flags must be an array of non-empty strings",
      });
    } else {
      compatibilityFlags = rawCompatFlags;
    }
  }

  // Pages production branch: optional publisher declaration. When absent the
  // plan defaults it to "main" (the provider requires an explicit value at
  // project create; Cloudflare error 8000033). Never silently dropped.
  let productionBranch: string | undefined;
  const rawProductionBranch = parsed["production_branch"];
  if (rawProductionBranch !== undefined) {
    if (typeof rawProductionBranch !== "string" || rawProductionBranch.trim().length === 0 || /\s/.test(rawProductionBranch) || rawProductionBranch.length > 128) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "production_branch",
        detail: "production_branch must be a non-empty string without whitespace (max 128 chars)",
      });
    } else {
      productionBranch = rawProductionBranch;
    }
  }

  // ---- kind / entry points -------------------------------------------------
  const rawPagesDir = parsed["pages_build_output_dir"];
  const isPages = rawPagesDir !== undefined;
  const rawMain = parsed["main"];
  const rawAssets = parsed["assets"];

  let main: string | undefined;
  if (rawMain !== undefined) {
    if (isPages) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "main",
        detail: "main must not be combined with pages_build_output_dir",
      });
    } else if (!isNonEmptyString(rawMain)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "main",
        detail: "main must be a non-empty string",
      });
    } else {
      const resolved = resolveZipRelativePath(baseDir, rawMain);
      if (resolved === null) {
        issues.push({
          code: "PATH_ESCAPES_UNIT",
          field: "main",
          detail: `main "${rawMain}" escapes the ZIP root`,
        });
      } else {
        const ext = extensionOf(resolved);
        if (UNCOMPILED_EXTENSIONS.has(ext)) {
          issues.push({
            code: "UNCOMPILED_ENTRYPOINT",
            field: "main",
            detail: `main "${rawMain}" is an uncompiled source file; the ZIP must contain the built ESM output (no browser build)`,
          });
        } else if (!ESM_EXTENSIONS.has(ext)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: "main",
            detail: `main "${rawMain}" must point to a built ESM module (.js or .mjs)`,
          });
        } else {
          main = resolved;
        }
      }
    }
  } else if (!isPages) {
    issues.push({
      code: "INVALID_SHAPE",
      field: "main",
      detail:
        "worker configs require a built ESM main module; assets-only workers are not supported by the V3 pipeline",
    });
  }

  let pagesDir: string | undefined;
  if (rawPagesDir !== undefined) {
    if (!isNonEmptyString(rawPagesDir)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "pages_build_output_dir",
        detail: "pages_build_output_dir must be a non-empty string",
      });
    } else {
      const resolved = resolveZipRelativePath(baseDir, rawPagesDir);
      if (resolved === null) {
        issues.push({
          code: "PATH_ESCAPES_UNIT",
          field: "pages_build_output_dir",
          detail: `pages_build_output_dir "${rawPagesDir}" escapes the ZIP root`,
        });
      } else {
        pagesDir = resolved;
      }
    }
  }

  // ---- assets --------------------------------------------------------------
  let assets: WranglerV3Assets | undefined;
  if (rawAssets !== undefined) {
    if (isPages) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "assets",
        detail: "Pages configs use pages_build_output_dir, not assets",
      });
    } else if (!isPlainObject(rawAssets)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "assets",
        detail: "assets must be an object",
      });
    } else {
      checkKnownKeys(rawAssets, ASSET_KEYS, "assets", issues);
      const directory = rawAssets["directory"];
      let directoryPath: string | undefined;
      if (!isNonEmptyString(directory)) {
        issues.push({
          code: "INVALID_SHAPE",
          field: "assets.directory",
          detail: "assets.directory must be a non-empty string",
        });
      } else {
        const resolved = resolveZipRelativePath(baseDir, directory);
        if (resolved === null) {
          issues.push({
            code: "PATH_ESCAPES_UNIT",
            field: "assets.directory",
            detail: `assets.directory "${directory}" escapes the ZIP root`,
          });
        } else {
          directoryPath = resolved;
        }
      }

      const binding = rawAssets["binding"];
      if (binding !== undefined && !isNonEmptyString(binding)) {
        issues.push({
          code: "INVALID_SHAPE",
          field: "assets.binding",
          detail: "assets.binding must be a non-empty string",
        });
      }
      const runWorkerFirst = rawAssets["run_worker_first"];
      if (
        runWorkerFirst !== undefined &&
        typeof runWorkerFirst !== "boolean" &&
        !isStringArray(runWorkerFirst)
      ) {
        issues.push({
          code: "INVALID_SHAPE",
          field: "assets.run_worker_first",
          detail: "assets.run_worker_first must be a boolean or an array of strings",
        });
      }
      const htmlHandling = rawAssets["html_handling"];
      if (
        htmlHandling !== undefined &&
        (typeof htmlHandling !== "string" || !HTML_HANDLING.has(htmlHandling))
      ) {
        issues.push({
          code: "INVALID_SHAPE",
          field: "assets.html_handling",
          detail: "assets.html_handling has an unsupported value",
        });
      }
      const notFoundHandling = rawAssets["not_found_handling"];
      if (
        notFoundHandling !== undefined &&
        (typeof notFoundHandling !== "string" ||
          !NOT_FOUND_HANDLING.has(notFoundHandling))
      ) {
        issues.push({
          code: "INVALID_SHAPE",
          field: "assets.not_found_handling",
          detail: "assets.not_found_handling has an unsupported value",
        });
      }

      if (directoryPath !== undefined && isNonEmptyString(directory)) {
        const nextAssets: WranglerV3Assets = {
          directory,
          directoryPath,
        };
        if (isNonEmptyString(binding)) {
          nextAssets.binding = binding;
        }
        if (typeof runWorkerFirst === "boolean" || isStringArray(runWorkerFirst)) {
          nextAssets.run_worker_first = runWorkerFirst;
        }
        if (typeof htmlHandling === "string" && HTML_HANDLING.has(htmlHandling)) {
          nextAssets.html_handling = htmlHandling;
        }
        if (
          typeof notFoundHandling === "string" &&
          NOT_FOUND_HANDLING.has(notFoundHandling)
        ) {
          nextAssets.not_found_handling = notFoundHandling;
        }
        assets = nextAssets;
      }
    }
  }

  // ---- workers_dev / routes ------------------------------------------------
  let workersDev: boolean | undefined;
  const rawWorkersDev = parsed["workers_dev"];
  if (rawWorkersDev !== undefined) {
    if (typeof rawWorkersDev !== "boolean") {
      issues.push({
        code: "INVALID_SHAPE",
        field: "workers_dev",
        detail: "workers_dev must be a boolean",
      });
    } else {
      workersDev = rawWorkersDev;
    }
  }

  const routes: WranglerV3Route[] = [];
  const rawRoutes = parsed["routes"];
  if (rawRoutes !== undefined) {
    if (!Array.isArray(rawRoutes)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "routes",
        detail: "routes must be an array of strings or route objects",
      });
    } else {
      for (let i = 0; i < rawRoutes.length; i++) {
        const item = rawRoutes[i];
        const field = `routes[${i}]`;
        if (typeof item === "string") {
          if (isNonEmptyString(item)) {
            routes.push({ pattern: item });
          } else {
            issues.push({
              code: "INVALID_SHAPE",
              field,
              detail: "route patterns must be non-empty strings",
            });
          }
          continue;
        }
        if (!isPlainObject(item)) {
          issues.push({
            code: "INVALID_SHAPE",
            field,
            detail: "routes entries must be strings or objects",
          });
          continue;
        }
        checkKnownKeys(item, ROUTE_KEYS, field, issues);
        const pattern = item["pattern"];
        if (!isNonEmptyString(pattern)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.pattern`,
            detail: "route objects require a non-empty pattern string",
          });
          continue;
        }
        const route: WranglerV3Route = { pattern };
        const customDomain = item["custom_domain"];
        if (customDomain !== undefined) {
          if (typeof customDomain !== "boolean") {
            issues.push({
              code: "INVALID_SHAPE",
              field: `${field}.custom_domain`,
              detail: "custom_domain must be a boolean",
            });
          } else {
            route.custom_domain = customDomain;
          }
        }
        for (const key of ["zone_id", "zone_name"] as const) {
          const value = item[key];
          if (value !== undefined) {
            if (!isNonEmptyString(value)) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.${key}`,
                detail: `${key} must be a non-empty string`,
              });
            } else {
              route[key] = value;
            }
          }
        }
        routes.push(route);
      }
    }
  }

  // ---- vars (plain values, never resources) --------------------------------
  let vars: Record<string, string | number | boolean> | undefined;
  const rawVars = parsed["vars"];
  if (rawVars !== undefined) {
    if (!isPlainObject(rawVars)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "vars",
        detail: "vars must be an object",
      });
    } else {
      vars = {};
      for (const [key, value] of Object.entries(rawVars)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          vars[key] = value;
        } else {
          issues.push({
            code: "INVALID_SHAPE",
            field: `vars.${key}`,
            detail: "var values must be a string, number, or boolean",
          });
        }
      }
    }
  }

  const { r2Buckets, d1Databases, kvNamespaces } = normalizeAccountResourceBindings(parsed, issues);
  const { hyperdrive, vectorize, secretsStoreSecrets, ai, browser } = normalizePlatformBindings(parsed, issues);

  const { queueProducers, queueConsumers } = normalizeQueues(parsed, issues);

  // ---- triggers.crons ------------------------------------------------------
  const crons: string[] = [];
  const rawTriggers = parsed["triggers"];
  if (rawTriggers !== undefined) {
    if (!isPlainObject(rawTriggers)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "triggers",
        detail: "triggers must be an object with an optional crons array",
      });
    } else {
      checkKnownKeys(rawTriggers, TRIGGER_KEYS, "triggers", issues);
      const rawCrons = rawTriggers["crons"];
      if (rawCrons !== undefined) {
        if (!Array.isArray(rawCrons)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: "triggers.crons",
            detail: "triggers.crons must be an array of cron strings",
          });
        } else {
          for (let i = 0; i < rawCrons.length; i++) {
            const cron = rawCrons[i];
            if (!isNonEmptyString(cron)) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `triggers.crons[${i}]`,
                detail: "cron entries must be non-empty strings",
              });
            } else if (!isValidCronExpression(cron)) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `triggers.crons[${i}]`,
                detail: `invalid cron expression "${cron.slice(0, 32)}" (expected 5 fields, e.g. "0 * * * *")`,
              });
            } else {
              crons.push(cron);
            }
          }
        }
      }
    }
  }

  const ratelimits = normalizeRateLimits(parsed, issues);

  // ---- workflows (no fetch handler required) -------------------------------
  const workflows: WranglerV3Workflow[] = [];
  const rawWorkflows = parsed["workflows"];
  if (rawWorkflows !== undefined) {
    if (!Array.isArray(rawWorkflows)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "workflows",
        detail: "workflows must be an array",
      });
    } else {
      for (let i = 0; i < rawWorkflows.length; i++) {
        const item = rawWorkflows[i];
        const field = `workflows[${i}]`;
        if (!isPlainObject(item)) {
          issues.push({
            code: "INVALID_SHAPE",
            field,
            detail: "workflows entries must be objects",
          });
          continue;
        }
        checkEntryKeys(item, WORKFLOW_KEYS, WORKFLOW_REFUSED_KEYS, field, issues);
        let valid = true;
        for (const key of ["name", "binding", "class_name"] as const) {
          if (!isNonEmptyString(item[key])) {
            issues.push({
              code: "INVALID_SHAPE",
              field: `${field}.${key}`,
              detail: `workflow ${key} must be a non-empty string`,
            });
            valid = false;
          }
        }
        const scriptName = item["script_name"];
        if (scriptName !== undefined && !isNonEmptyString(scriptName)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.script_name`,
            detail: "workflow script_name must be a non-empty string",
          });
          valid = false;
        }
        // direct schedules follow the official validation exactly (a
        // non-empty string or a non-empty array of strings; empty strings are
        // refused, not trimmed).
        const schedules = item["schedules"];
        let normalizedSchedules: string[] | undefined;
        if (schedules !== undefined) {
          if (typeof schedules === "string") {
            if (schedules.length === 0) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.schedules`,
                detail: "workflow schedules must not be an empty string",
              });
              valid = false;
            } else {
              normalizedSchedules = [schedules];
            }
          } else if (Array.isArray(schedules)) {
            if (schedules.length === 0) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.schedules`,
                detail: "workflow schedules must not be an empty array",
              });
              valid = false;
            } else if (!schedules.every((entry) => typeof entry === "string")) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.schedules`,
                detail:
                  "workflow schedules must be a non-empty string or a non-empty array of strings",
              });
              valid = false;
            } else if (schedules.some((entry) => entry.length === 0)) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.schedules`,
                detail: "workflow schedules must not contain empty strings",
              });
              valid = false;
            } else {
              normalizedSchedules = [...schedules];
            }
          } else {
            issues.push({
              code: "INVALID_SHAPE",
              field: `${field}.schedules`,
              detail:
                "workflow schedules must be a non-empty string or a non-empty array of strings",
            });
            valid = false;
          }
        }
        if (valid) {
          const workflow: WranglerV3Workflow = {
            name: item["name"] as string,
            binding: item["binding"] as string,
            class_name: item["class_name"] as string,
          };
          if (isNonEmptyString(scriptName)) {
            workflow.script_name = scriptName;
          }
          if (normalizedSchedules !== undefined) {
            workflow.schedules = normalizedSchedules;
          }
          workflows.push(workflow);
        }
      }
    }
  }

  // ---- durable_objects + migrations ---------------------------------------
  const durableObjects: WranglerV3DurableObjectBinding[] = [];
  const rawDurableObjects = parsed["durable_objects"];
  if (rawDurableObjects !== undefined) {
    if (!isPlainObject(rawDurableObjects)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "durable_objects",
        detail: "durable_objects must be an object with a bindings array",
      });
    } else {
      checkKnownKeys(rawDurableObjects, new Set(["bindings"]), "durable_objects", issues);
      const bindings = rawDurableObjects["bindings"];
      if (!Array.isArray(bindings)) {
        issues.push({
          code: "INVALID_SHAPE",
          field: "durable_objects.bindings",
          detail: "durable_objects.bindings must be an array",
        });
      } else {
        for (let i = 0; i < bindings.length; i++) {
          const item = bindings[i];
          const field = `durable_objects.bindings[${i}]`;
          if (!isPlainObject(item)) {
            issues.push({
              code: "INVALID_SHAPE",
              field,
              detail: "durable object bindings must be objects",
            });
            continue;
          }
          checkKnownKeys(item, DURABLE_OBJECT_KEYS, field, issues);
          let valid = true;
          for (const key of ["name", "class_name"] as const) {
            if (!isNonEmptyString(item[key])) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.${key}`,
                detail: `durable object ${key} must be a non-empty string`,
              });
              valid = false;
            }
          }
          for (const key of ["script_name", "environment"] as const) {
            const value = item[key];
            if (value !== undefined && !isNonEmptyString(value)) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.${key}`,
                detail: `${key} must be a non-empty string`,
              });
              valid = false;
            }
          }
          if (valid) {
            const binding: WranglerV3DurableObjectBinding = {
              name: item["name"] as string,
              class_name: item["class_name"] as string,
            };
            if (isNonEmptyString(item["script_name"])) {
              binding.script_name = item["script_name"];
            }
            if (isNonEmptyString(item["environment"])) {
              binding.environment = item["environment"];
            }
            durableObjects.push(binding);
          }
        }
      }
    }
  }

  const migrations: WranglerV3Migration[] = [];
  const rawMigrations = parsed["migrations"];
  if (rawMigrations !== undefined) {
    if (!Array.isArray(rawMigrations)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "migrations",
        detail: "migrations must be an array",
      });
    } else {
      const migrationKeys = new Set([
        "tag",
        "new_classes",
        "new_sqlite_classes",
        "renamed_classes",
        "deleted_classes",
      ]);
      for (let i = 0; i < rawMigrations.length; i++) {
        const item = rawMigrations[i];
        const field = `migrations[${i}]`;
        if (!isPlainObject(item)) {
          issues.push({
            code: "INVALID_SHAPE",
            field,
            detail: "migration entries must be objects",
          });
          continue;
        }
        for (const key of Object.keys(item)) {
          if (migrationKeys.has(key)) {
            continue;
          }
          if (key === "transferred_classes") {
            issues.push({
              code: "UNSUPPORTED_WRANGLER_FEATURE",
              field: `${field}.transferred_classes`,
              detail:
                "transferred_classes migrations are not supported by the TapDeploy V3 pipeline yet",
            });
            continue;
          }
          issues.push({
            code: "UNKNOWN_WRANGLER_FIELD",
            field: `${field}.${key}`,
            detail: `migration field "${key}" is not recognized and is refused rather than ignored`,
          });
        }
        const tag = item["tag"];
        if (!isNonEmptyString(tag)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.tag`,
            detail: "migration tag must be a non-empty string",
          });
          continue;
        }
        const migration: WranglerV3Migration = { tag };
        let valid = true;
        for (const key of ["new_classes", "new_sqlite_classes", "deleted_classes"] as const) {
          const value = item[key];
          if (value === undefined) {
            continue;
          }
          if (!isStringArray(value)) {
            issues.push({
              code: "INVALID_SHAPE",
              field: `${field}.${key}`,
              detail: `${key} must be an array of non-empty strings`,
            });
            valid = false;
          } else {
            migration[key] = value;
          }
        }
        const renamed = item["renamed_classes"];
        if (renamed !== undefined) {
          if (!Array.isArray(renamed)) {
            issues.push({
              code: "INVALID_SHAPE",
              field: `${field}.renamed_classes`,
              detail: "renamed_classes must be an array",
            });
            valid = false;
          } else {
            const pairs: { from: string; to: string }[] = [];
            for (let j = 0; j < renamed.length; j++) {
              const pair = renamed[j];
              const pairField = `${field}.renamed_classes[${j}]`;
              if (!isPlainObject(pair)) {
                issues.push({
                  code: "INVALID_SHAPE",
                  field: pairField,
                  detail: "renamed_classes entries must be objects",
                });
                valid = false;
                continue;
              }
              checkKnownKeys(pair, new Set(["from", "to"]), pairField, issues);
              if (!isNonEmptyString(pair["from"]) || !isNonEmptyString(pair["to"])) {
                issues.push({
                  code: "INVALID_SHAPE",
                  field: pairField,
                  detail: "renamed_classes entries require from and to strings",
                });
                valid = false;
                continue;
              }
              pairs.push({ from: pair["from"], to: pair["to"] });
            }
            if (valid) {
              migration.renamed_classes = pairs;
            }
          }
        }
        if (valid) {
          migrations.push(migration);
        }
      }
    }
  }

  // ---- services ------------------------------------------------------------
  const services: WranglerV3ServiceBinding[] = [];
  const rawServices = parsed["services"];
  if (rawServices !== undefined) {
    if (!Array.isArray(rawServices)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "services",
        detail: "services must be an array",
      });
    } else {
      for (let i = 0; i < rawServices.length; i++) {
        const item = rawServices[i];
        const field = `services[${i}]`;
        if (!isPlainObject(item)) {
          issues.push({
            code: "INVALID_SHAPE",
            field,
            detail: "services entries must be objects",
          });
          continue;
        }
        checkEntryKeys(item, SERVICE_KEYS, SERVICE_REFUSED_KEYS, field, issues);
        let valid = true;
        for (const key of ["binding", "service"] as const) {
          if (!isNonEmptyString(item[key])) {
            issues.push({
              code: "INVALID_SHAPE",
              field: `${field}.${key}`,
              detail: `service ${key} must be a non-empty string`,
            });
            valid = false;
          }
        }
        for (const key of ["environment", "entrypoint"] as const) {
          const value = item[key];
          if (value !== undefined && !isNonEmptyString(value)) {
            issues.push({
              code: "INVALID_SHAPE",
              field: `${field}.${key}`,
              detail: `${key} must be a non-empty string`,
            });
            valid = false;
          }
        }
        const props = item["props"];
        if (props !== undefined && !isPlainObject(props)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.props`,
            detail: "service props must be a JSON object",
          });
          valid = false;
        }
        if (valid) {
          const service: WranglerV3ServiceBinding = {
            binding: item["binding"] as string,
            service: item["service"] as string,
          };
          if (isNonEmptyString(item["environment"])) {
            service.environment = item["environment"];
          }
          if (isNonEmptyString(item["entrypoint"])) {
            service.entrypoint = item["entrypoint"];
          }
          if (isPlainObject(props)) {
            service.props = props;
          }
          services.push(service);
        }
      }
    }
  }

  // ---- rules (prebuilt module semantics only) ------------------------------
  const rules: WranglerV3Rule[] = [];
  const rawRules = parsed["rules"];
  if (rawRules !== undefined) {
    if (!Array.isArray(rawRules)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "rules",
        detail: "rules must be an array",
      });
    } else {
      for (let i = 0; i < rawRules.length; i++) {
        const item = rawRules[i];
        const field = `rules[${i}]`;
        if (!isPlainObject(item)) {
          issues.push({
            code: "INVALID_SHAPE",
            field,
            detail: "rules entries must be objects",
          });
          continue;
        }
        checkKnownKeys(item, RULE_KEYS, field, issues);
        const type = item["type"];
        if (type === "ESModule" || type === "CommonJS") {
          issues.push({
            code: "UNSUPPORTED_WRANGLER_FEATURE",
            field: `${field}.type`,
            detail: `rules type "${type}" is a bundling-time rule; the V3 pipeline consumes already-built modules`,
          });
          continue;
        }
        if (type !== "Text" && type !== "Data" && type !== "CompiledWasm") {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.type`,
            detail: "rules type must be Text, Data, or CompiledWasm",
          });
          continue;
        }
        const globs = item["globs"];
        if (!isStringArray(globs) || globs.length === 0) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.globs`,
            detail: "rules globs must be a non-empty array of strings",
          });
          continue;
        }
        const fallthrough = item["fallthrough"];
        if (fallthrough !== undefined && typeof fallthrough !== "boolean") {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.fallthrough`,
            detail: "rules fallthrough must be a boolean",
          });
          continue;
        }
        const rule: WranglerV3Rule = { type, globs };
        if (typeof fallthrough === "boolean") {
          rule.fallthrough = fallthrough;
        }
        rules.push(rule);
      }
    }
  }

  // ---- env-surface collision check (bindings stay typed, never process.env) -
  const envSurface = new Map<string, string>();
  const registerEnvName = (envName: string | undefined, source: string): void => {
    if (envName === undefined) {
      return;
    }
    const previous = envSurface.get(envName);
    if (previous !== undefined) {
      issues.push({
        code: "INVALID_SHAPE",
        field: source,
        detail: `binding/variable name "${envName}" is already used by ${previous}`,
      });
    } else {
      envSurface.set(envName, source);
    }
  };
  for (const key of Object.keys(vars ?? {})) {
    registerEnvName(key, "vars");
  }
  for (const workflow of workflows) {
    registerEnvName(workflow.binding, `workflows binding "${workflow.name}"`);
  }
  for (const binding of durableObjects) {
    registerEnvName(binding.name, `durable_objects binding "${binding.class_name}"`);
  }
  for (const service of services) {
    registerEnvName(service.binding, `services binding "${service.service}"`);
  }
  for (const ratelimit of ratelimits) {
    registerEnvName(ratelimit.name, `ratelimits namespace "${ratelimit.namespace_id}"`);
  }
  for (const r2 of r2Buckets) {
    registerEnvName(r2.binding, `r2_buckets bucket "${r2.bucketName}"`);
  }
  for (const d1 of d1Databases) {
    registerEnvName(d1.binding, `d1_databases database "${d1.databaseName}"`);
  }
  for (const kv of kvNamespaces) {
    registerEnvName(kv.binding, `kv_namespaces namespace "${kv.namespaceId}"`);
  }
  for (const producer of queueProducers) {
    registerEnvName(producer.binding, `queues producer for "${producer.queue}"`);
  }
  // Queue consumers carry no Worker environment binding: they register a
  // trigger on the queue's consumers subresource and add no env name.
  for (const entry of hyperdrive) registerEnvName(entry.binding, `hyperdrive config "${entry.id}"`);
  for (const entry of vectorize) registerEnvName(entry.binding, `vectorize index "${entry.indexName}"`);
  for (const entry of secretsStoreSecrets) registerEnvName(entry.binding, `secrets_store_secrets secret "${entry.secretName}"`);
  registerEnvName(ai?.binding, "ai.binding");
  registerEnvName(browser?.binding, "browser.binding");
  registerEnvName(assets?.binding, "assets.binding");

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const kind: WranglerV3Kind = isPages ? "pages" : "worker";
  const config: WranglerV3Config = {
    kind,
    configPath,
    baseDir,
    name: name as string,
    compatibility_date: compatibilityDate as string,
    compatibility_flags: compatibilityFlags,
    ...(main !== undefined ? { main } : {}),
    ...(pagesDir !== undefined ? { pages_build_output_dir: pagesDir } : {}),
    ...(productionBranch !== undefined ? { production_branch: productionBranch } : {}),
    ...(assets !== undefined ? { assets } : {}),
    ...(workersDev !== undefined ? { workers_dev: workersDev } : {}),
    routes,
    ...(vars !== undefined ? { vars } : {}),
    crons,
    r2Buckets,
    d1Databases,
    kvNamespaces,
    hyperdrive,
    vectorize,
    secretsStoreSecrets,
    ...(ai ? { ai } : {}),
    ...(browser ? { browser } : {}),
    queueProducers,
    queueConsumers,
    ratelimits,
    workflows,
    durableObjects,
    migrations,
    services,
    rules,
    inertFields: [...inertFields].sort(),
  };

  return { ok: true, config, issues: [] };
}

// Canonical Wrangler cron shape is `triggers: { crons: [...] }` (object, not
// an array). This is a syntactic guard only: it rejects malformed entries
// without throwing and fails closed on anything outside the 5-field numeric
// cron subset v1 supports. Unknown future cron syntax must fail, never deploy
// silently.
function isValidCronExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    return false;
  }
  if (!/^[\x20-\x7E]+$/.test(trimmed)) {
    return false;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }
  for (const p of parts) {
    if (p.length === 0 || p.length > 20) {
      return false;
    }
    if (!/^[0-9*,\-/]+$/.test(p)) {
      return false;
    }
  }
  return true;
}
