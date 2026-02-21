import crypto from "crypto"

export function sha256OfString(content: string): string {
	return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`
}

export function sha256OfBuffer(content: Buffer): string {
	return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`
}
