import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { jobInputSchemas, jobOutputSchemas } from "../schemas/index.js";

const outputPath = resolve("generated/job-schemas.json");

const jobs = Object.fromEntries(
  Object.keys(jobInputSchemas).map((jobType) => [
    jobType,
    {
      input: zodToJsonSchema(jobInputSchemas[jobType as keyof typeof jobInputSchemas], {
        $refStrategy: "none",
        target: "jsonSchema7",
      }),
      output: zodToJsonSchema(jobOutputSchemas[jobType as keyof typeof jobOutputSchemas], {
        $refStrategy: "none",
        target: "jsonSchema7",
      }),
    },
  ]),
);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      jobs,
    },
    null,
    2,
  )}\n`,
);
