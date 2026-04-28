import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

// --- [스캐너 유틸리티 함수들] ---
interface ScanResults {
    exe: string[];
    bat: string[];
}

const ensureDirectoryExists = (dirPath: string): void => {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const categorizeFile = (filePath: string, results: ScanResults): void => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.exe') results.exe.push(filePath);
    else if (ext === '.bat') results.bat.push(filePath);
};

const scanDirectory = (currentDir: string, currentDepth: number = 1, maxDepth: number = 5, results: ScanResults = { exe: [], bat: [] }): ScanResults => {
    if (currentDepth > maxDepth) return results;
    try {
        const files = fs.readdirSync(currentDir);
        for (const file of files) {
            const fullPath = path.join(currentDir, file);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    scanDirectory(fullPath, currentDepth + 1, maxDepth, results);
                } else {
                    categorizeFile(fullPath, results);
                }
            } catch (err) { continue; }
        }
    } catch (err) {}
    return results;
};
// --------------------------------

const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });

// 스캔 결과를 저장할 경로 설정
const userHomeDir = os.homedir(); 
const outputDir = path.join(userHomeDir, '.freel_agent', 'path');
const exeOutputPath = path.join(outputDir, 'exe_results.txt');
const batOutputPath = path.join(outputDir, 'bat_results.txt');

console.log(`[Freel-Desktop] Background executor started on ws://localhost:${PORT}`);

wss.on('connection', (ws: WebSocket) => {
  console.log('[Freel-Desktop] Agent connected.');

  ws.on('message', async (message: string) => {
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(message);
      const { taskId, action, parameters } = parsedPayload;
      
      console.log(`\n[Freel-Desktop] 🚀 Task Received: ${action}`);

      let resultData = null;

      switch (action) {
        // 기존 액션들
        case 'filesystem_list':
          const targetDir = parameters.path || './';
          const files = fs.readdirSync(targetDir);
          resultData = { path: targetDir, files };
          break;

        case 'system_execute':
          const command = parameters.command;
          console.log(`[Freel-Desktop] Executing: ${command}`);
          const { stdout, stderr } = await execAsync(command);
          resultData = { command, stdout: stdout.trim(), stderr: stderr.trim() };
          break;

        // 🆕 새 액션 1: PC 전체 스캔 및 캐시 저장
        case 'system_scan':
          const scanPath = parameters.path || 'C:\\';
          const maxDepth = parameters.depth || 5;
          console.log(`[Freel-Desktop] 🔍 Scanning ${scanPath} (Depth: ${maxDepth})...`);
          
          ensureDirectoryExists(outputDir);
          const foundFiles = scanDirectory(scanPath, 1, maxDepth);
          
          fs.writeFileSync(exeOutputPath, foundFiles.exe.join('\n'), 'utf-8');
          fs.writeFileSync(batOutputPath, foundFiles.bat.join('\n'), 'utf-8');
          
          resultData = { 
            message: "Scan complete", 
            exeSaved: foundFiles.exe.length, 
            batSaved: foundFiles.bat.length 
          };
          break;

        // 🆕 새 액션 2: 캐시 파일에서 애플리케이션 검색
        case 'find_application':
          const keywords = Array.isArray(parameters.keywords) 
            ? parameters.keywords.map((k: string) => k.toLowerCase()) 
            : [parameters.keywords.toLowerCase()];
            
          const matchedPaths: string[] = [];

          const searchInFile = (filePath: string) => {
              if (fs.existsSync(filePath)) {
                  const content = fs.readFileSync(filePath, 'utf-8');
                  const lines = content.split('\n');
                  for (const line of lines) {
                      const cleanPath = line.trim();
                      if (!cleanPath) continue;
                      const fileName = path.basename(cleanPath).toLowerCase();
                      if (keywords.some((keyword: string) => fileName.includes(keyword))) {
                          matchedPaths.push(cleanPath);
                      }
                  }
              }
          };

          searchInFile(exeOutputPath);
          searchInFile(batOutputPath);

          // 여러 개가 검색될 수 있으므로 최대 5개까지만 반환하여 AI가 헷갈리지 않게 조절
          resultData = { 
            keywords, 
            matchedPaths: matchedPaths.slice(0, 5),
            totalMatches: matchedPaths.length
          };
          break;

        // 🆕 새 액션 3: 파일 생성 및 덮어쓰기
        case 'filesystem_write': {
          const { path: writePath, content } = parameters;
          // 폴더가 없으면 에러가 날 수 있으므로 폴더 생성 보장 로직 추가
          const dirPath = path.dirname(writePath);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
          fs.writeFileSync(writePath, content, 'utf-8');
          resultData = { message: `성공적으로 파일을 저장했습니다: ${writePath}` };
          break;
        }

        // 🆕 새 액션 4: 파일 내용 덧붙이기 (Append)
        case 'filesystem_append': {
          const { path: appendPath, content: appendContent } = parameters;
          if (!fs.existsSync(appendPath)) {
            throw new Error(`파일을 찾을 수 없습니다: ${appendPath}`);
          }
          // 줄바꿈을 포함하여 기존 파일 끝에 내용을 덧붙임
          fs.appendFileSync(appendPath, `\n${appendContent}`, 'utf-8');
          resultData = { message: `성공적으로 내용을 추가했습니다: ${appendPath}` };
          break;
        }

        // 🆕 새 액션 5: 파일 또는 폴더 삭제
        case 'filesystem_delete': {
          const { path: deletePath } = parameters;
          if (!fs.existsSync(deletePath)) {
            throw new Error(`삭제할 파일/폴더가 존재하지 않습니다: ${deletePath}`);
          }
          
          const stat = fs.statSync(deletePath);
          if (stat.isDirectory()) {
            // 폴더일 경우 내부 파일까지 모두 삭제 (Node.js v14.14.0 이상 권장)
            fs.rmSync(deletePath, { recursive: true, force: true });
          } else {
            // 파일일 경우 삭제
            fs.unlinkSync(deletePath);
          }
          resultData = { message: `성공적으로 삭제되었습니다: ${deletePath}` };
          break;
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      ws.send(JSON.stringify({ taskId, status: 'success', data: resultData, error: null }));
      console.log(`[Freel-Desktop] ✅ Task Completed: ${action}`);

    } catch (error) {
      console.error('[Freel-Desktop] ❌ Task failed:', error);
      ws.send(JSON.stringify({
        taskId: parsedPayload?.taskId || 'unknown',
        status: 'error',
        data: null,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  });
});