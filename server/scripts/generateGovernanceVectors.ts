import fs from "fs";
import path from "path";
import {
  hashGovernanceAction,
  type GovernanceAction,
} from "../src/governance/actionSchema";

interface VectorFile {
  description: string;
  vectors: Array<{ name: string; action: GovernanceAction; expectedHash: string }>;
  note: string;
}

const filePath = path.join(__dirname, "../src/governance/governance-test-vectors.json");
const file: VectorFile = JSON.parse(fs.readFileSync(filePath, "utf8"));

for (const vector of file.vectors) {
  vector.expectedHash = hashGovernanceAction(vector.action);
}

fs.writeFileSync(filePath, JSON.stringify(file, null, 2) + "\n");
console.log(`Regenerated ${file.vectors.length} governance test vector(s) at ${filePath}`);
