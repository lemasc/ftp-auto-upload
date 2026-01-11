import fs from "fs";
import path from "path";
import { Client } from "basic-ftp";
import chokidar from "chokidar";

require('dotenv').config();

class FTPFileWatcher {
    private watchFolder: string;
    private uploadedFilesPath: string;
    private uploadedFiles: Set<string>;
    private ftpConfig: {
        host: string;
        port: number;
        user: string;
        password: string;
        secure: boolean
    }
    private retryConfig: {
        maxRetries: number;
        initialDelayMs: number;
        maxDelayMs: number;
        backoffMultiplier: number;
    }
    constructor(watchFolder: string) {
        this.watchFolder = path.resolve(watchFolder);
        this.uploadedFilesPath = path.join(process.cwd(), 'uploaded-files.json');
        this.uploadedFiles = this.loadUploadedFiles();
        this.ftpConfig = {
            host: process.env.FTP_HOST ?? "",
            port: parseInt(process.env.FTP_PORT as string) || 21,
            user: process.env.FTP_USER ?? "",
            password: process.env.FTP_PASSWORD ?? "",
            secure: process.env.FTP_SECURE === 'true'
        };
        this.retryConfig = {
            maxRetries: parseInt(process.env.FTP_MAX_RETRIES as string) || 3,
            initialDelayMs: parseInt(process.env.FTP_RETRY_DELAY_MS as string) || 1000,
            maxDelayMs: parseInt(process.env.FTP_MAX_RETRY_DELAY_MS as string) || 30000,
            backoffMultiplier: parseFloat(process.env.FTP_BACKOFF_MULTIPLIER as string) || 2
        };

        // Validate FTP configuration
        if (!this.ftpConfig.host || !this.ftpConfig.user || !this.ftpConfig.password) {
            throw new Error('Missing FTP configuration in .env file. Required: FTP_HOST, FTP_USER, FTP_PASSWORD');
        }

        console.log(`Watching folder: ${this.watchFolder}`);
        console.log(`Uploaded files tracking: ${this.uploadedFilesPath}`);
        console.log(`Retry configuration: max ${this.retryConfig.maxRetries} attempts with ${this.retryConfig.initialDelayMs}ms initial delay`);
    }

    loadUploadedFiles() {
        try {
            if (fs.existsSync(this.uploadedFilesPath)) {
                const data = fs.readFileSync(this.uploadedFilesPath, 'utf8');
                return new Set<string>(JSON.parse(data));
            }
        } catch (error) {
            console.warn('Could not load uploaded files list:', error instanceof Error ? error.message : error);
        }
        return new Set<string>();
    }

    saveUploadedFiles() {
        try {
            fs.writeFileSync(this.uploadedFilesPath, JSON.stringify([...this.uploadedFiles], null, 2));
        } catch (error) {
            console.error('Could not save uploaded files list:', error instanceof Error ? error.message : error);
        }
    }

    getRelativePath(filePath: string) {
        return path.relative(this.watchFolder, filePath);
    }

    private calculateRetryDelay(attemptNumber: number): number {
        const delay = this.retryConfig.initialDelayMs * Math.pow(this.retryConfig.backoffMultiplier, attemptNumber);
        return Math.min(delay, this.retryConfig.maxDelayMs);
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async uploadFile(filePath: string) {
        const relativePath = this.getRelativePath(filePath);
        let lastError: Error | unknown;

        for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
            const client = new Client();

            try {
                if (attempt > 0) {
                    const delayMs = this.calculateRetryDelay(attempt - 1);
                    console.log(`⏳ Retry attempt ${attempt}/${this.retryConfig.maxRetries} for ${relativePath} after ${delayMs}ms delay...`);
                    await this.sleep(delayMs);
                }

                console.log(`Connecting to FTP server...`);
                await client.access(this.ftpConfig);

                // Ensure directory structure exists on FTP server
                const remoteDir = path.dirname(relativePath).replace(/\\/g, '/');
                if (remoteDir !== '.') {
                    try {
                        await client.ensureDir(remoteDir);
                    } catch (error) {
                        console.warn(`Could not create directory ${remoteDir}:`, error instanceof Error ? error.message : error);
                    }
                }

                // Upload the file
                const remotePath = relativePath.replace(/\\/g, '/');
                console.log(`Uploading: ${filePath} -> ${remotePath}`);

                await client.uploadFrom(filePath, remotePath);

                // Mark file as uploaded
                this.uploadedFiles.add(relativePath);
                this.saveUploadedFiles();

                console.log(`✅ Successfully uploaded: ${relativePath}`);

                client.close();
                return; // Success - exit the retry loop

            } catch (error) {
                lastError = error;
                client.close();

                if (attempt < this.retryConfig.maxRetries) {
                    console.warn(`⚠️  Upload attempt ${attempt + 1} failed for ${relativePath}:`, error instanceof Error ? error.message : error);
                } else {
                    console.error(`❌ Failed to upload ${relativePath} after ${this.retryConfig.maxRetries + 1} attempts:`, error instanceof Error ? error.message : error);
                    throw error;
                }
            }
        }

        // This should never be reached due to the throw above, but TypeScript needs it
        throw lastError;
    }

    async handleFileChange(filePath: string, event: string) {
        const relativePath = this.getRelativePath(filePath);

        try {
            // Check if file exists and is readable
            if (!fs.existsSync(filePath)) {
                console.log(`File deleted or moved: ${relativePath}`);
                return;
            }

            const stats = fs.statSync(filePath);
            if (!stats.isFile()) {
                return; // Skip directories
            }

            // Skip files that are already uploaded unless they've been modified
            if (this.uploadedFiles.has(relativePath) && event !== 'change') {
                console.log(`Skipping already uploaded file: ${relativePath}`);
                return;
            }

            console.log(`File ${event}: ${relativePath}`);

            // Add a small delay to ensure file is completely written
            await new Promise(resolve => setTimeout(resolve, 1000));

            await this.uploadFile(filePath);

        } catch (error) {
            console.error(`Error handling file change for ${relativePath}:`, error instanceof Error ? error.message : error);
        }
    }

    start() {
        if (!fs.existsSync(this.watchFolder)) {
            throw new Error(`Watch folder does not exist: ${this.watchFolder}`);
        }

        console.log('Starting FTP file watcher...');
        console.log(`FTP Server: ${this.ftpConfig.host}:${this.ftpConfig.port}`);
        console.log(`Uploaded files so far: ${this.uploadedFiles.size}`);

        const watcher = chokidar.watch(this.watchFolder, {
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        watcher
            .on('add', filePath => this.handleFileChange(filePath, 'add'))
            .on('change', filePath => this.handleFileChange(filePath, 'change'))
            .on('ready', () => {
                console.log('🚀 File watcher is ready and monitoring for changes...');
            })
            .on('error', error => {
                console.error('Watcher error:', error);
            });

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n📝 Saving uploaded files list...');
            this.saveUploadedFiles();
            console.log('👋 Shutting down gracefully...');
            watcher.close().then(() => process.exit(0));
        });

        return watcher;
    }
}

// Main execution
async function main() {
    const watchFolder = process.argv[2];

    if (!watchFolder) {
        console.error('Usage: ftp-watcher.exe <folder-to-watch>');
        console.error('Example: ftp-watcher.exe C:\\MyDocuments\\uploads');
        process.exit(1);
    }

    try {
        const watcher = new FTPFileWatcher(watchFolder);
        watcher.start();
    } catch (error) {
        console.error('Failed to start FTP file watcher:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

main()