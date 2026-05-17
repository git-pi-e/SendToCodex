"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const adm_zip_1 = __importDefault(require("adm-zip"));
const fse = __importStar(require("fs-extra"));
// Files/dirs to skip when backing up .codex
const SKIP_PATTERNS = [".lock", ".tmp"];
const SKIP_NAMES = ["tmp"];
class AccountManager {
    constructor() {
        const home = os.homedir();
        this.codexHome = path.join(home, ".codex");
        this.dataDir = path.join(home, "codex-data");
        this.stateDir = path.join(home, ".codex-switch");
        this.stateFile = path.join(this.stateDir, "state");
    }
    ensureDirs() {
        fs.mkdirSync(this.dataDir, { recursive: true });
        fs.mkdirSync(this.stateDir, { recursive: true });
    }
    zipPathFor(name) {
        return path.join(this.dataDir, `${name}.zip`);
    }
    listAccounts() {
        this.ensureDirs();
        if (!fs.existsSync(this.dataDir)) {
            return [];
        }
        return fs
            .readdirSync(this.dataDir)
            .filter((f) => f.toLowerCase().endsWith(".zip"))
            .map((f) => f.slice(0, -4))
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    }
    loadState() {
        const state = { current: "", previous: "" };
        if (!fs.existsSync(this.stateFile)) {
            return state;
        }
        const lines = fs.readFileSync(this.stateFile, "utf-8").split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.includes("=")) {
                continue;
            }
            const eqIdx = trimmed.indexOf("=");
            const key = trimmed.slice(0, eqIdx);
            const raw = trimmed
                .slice(eqIdx + 1)
                .trim()
                .replace(/^['"]|['"]$/g, "");
            if (key === "CURRENT") {
                state.current = raw;
            }
            else if (key === "PREVIOUS") {
                state.previous = raw;
            }
        }
        return state;
    }
    saveState(current, previous) {
        this.ensureDirs();
        const content = `CURRENT=${JSON.stringify(current)}\nPREVIOUS=${JSON.stringify(previous)}\n`;
        fs.writeFileSync(this.stateFile, content, "utf-8");
    }
    codexExists() {
        try {
            return fs.statSync(this.codexHome).isDirectory();
        }
        catch {
            return false;
        }
    }
    backupCurrentTo(name) {
        this.validateName(name);
        if (!this.codexExists()) {
            throw new Error(`Could not find ${this.codexHome}. Please sign in to a Codex account first.`);
        }
        const dest = this.zipPathFor(name);
        this.ensureDirs();
        const zip = new adm_zip_1.default();
        this.addDirToZip(zip, this.codexHome, ".codex");
        zip.writeZip(dest);
    }
    addDirToZip(zip, localDir, zipDir) {
        let entries;
        try {
            entries = fs.readdirSync(localDir, { withFileTypes: true });
        }
        catch {
            return; // skip unreadable dirs
        }
        for (const entry of entries) {
            if (SKIP_NAMES.includes(entry.name)) {
                continue;
            }
            if (SKIP_PATTERNS.some((p) => entry.name.endsWith(p))) {
                continue;
            }
            const localPath = path.join(localDir, entry.name);
            if (entry.isDirectory()) {
                this.addDirToZip(zip, localPath, zipDir + "/" + entry.name);
            }
            else {
                try {
                    zip.addLocalFile(localPath, zipDir);
                }
                catch {
                    // skip files we can't read
                }
            }
        }
    }
    extractAccount(name) {
        this.validateName(name);
        const zipPath = this.zipPathFor(name);
        if (!fs.existsSync(zipPath)) {
            throw new Error(`No saved account found: ${name}`);
        }
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-"));
        try {
            const zip = new adm_zip_1.default(zipPath);
            zip.extractAllTo(tmpDir, /* overwrite */ true);
            const extracted = this.findExtractedCodex(tmpDir);
            if (!extracted) {
                throw new Error("Archive does not contain a .codex directory");
            }
            if (this.codexExists()) {
                fse.removeSync(this.codexHome);
            }
            fse.moveSync(extracted, this.codexHome);
        }
        finally {
            try {
                fse.removeSync(tmpDir);
            }
            catch {
                /* ignore cleanup errors */
            }
        }
    }
    findExtractedCodex(base) {
        let entries;
        try {
            entries = fs.readdirSync(base, { withFileTypes: true });
        }
        catch {
            return null;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const fullPath = path.join(base, entry.name);
            if (entry.name === ".codex") {
                return fullPath;
            }
            const found = this.findExtractedCodex(fullPath);
            if (found) {
                return found;
            }
        }
        return null;
    }
    saveCurrentAs(name) {
        this.validateName(name);
        this.backupCurrentTo(name);
        const state = this.loadState();
        this.saveState(name, state.current);
    }
    switchTo(target, unknownCurrentName) {
        this.validateName(target);
        if (!fs.existsSync(this.zipPathFor(target))) {
            throw new Error(`Account '${target}' not found in saved archives.`);
        }
        this.ensureDirs();
        const state = this.loadState();
        if (this.codexExists()) {
            let currentName = state.current;
            if (!currentName) {
                if (!unknownCurrentName) {
                    throw new Error("Current account has no name. Provide a name before switching.");
                }
                currentName = this.validateName(unknownCurrentName);
                this.backupCurrentTo(currentName);
                this.saveState(currentName, "");
            }
            else {
                this.backupCurrentTo(currentName);
            }
        }
        this.extractAccount(target);
        this.saveState(target, state.current);
    }
    prepareAdd(newName, unknownCurrentName) {
        this.validateName(newName);
        this.ensureDirs();
        const state = this.loadState();
        if (this.codexExists()) {
            let currentName = state.current;
            if (!currentName) {
                if (!unknownCurrentName) {
                    throw new Error("Current account has no name. Provide a name to create a backup.");
                }
                currentName = this.validateName(unknownCurrentName);
                this.backupCurrentTo(currentName);
                this.saveState(currentName, "");
            }
            else {
                this.backupCurrentTo(currentName);
            }
            fse.removeSync(this.codexHome);
        }
    }
    deleteAccount(name) {
        this.validateName(name);
        const p = this.zipPathFor(name);
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
        }
        const state = this.loadState();
        const current = state.current === name ? "" : state.current;
        const previous = state.previous === name ? "" : state.previous;
        if (current !== state.current || previous !== state.previous) {
            this.saveState(current, previous);
        }
    }
    validateName(name) {
        const clean = name.trim();
        if (!clean) {
            throw new Error("Account name cannot be empty.");
        }
        const invalidChars = ["/", "\\", ":", "*", "?", '"', "<", ">", "|"];
        if (invalidChars.some((ch) => clean.includes(ch))) {
            throw new Error("Account name contains invalid characters.");
        }
        return clean;
    }
}
exports.AccountManager = AccountManager;
//# sourceMappingURL=accountManager.js.map