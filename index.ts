import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

const getAvailableDrives = async (): Promise<string[]> => {
  if (os.platform() === 'win32') {
    try {
      const { stdout } = await execAsync('wmic logicaldisk get name');
      // 출력값에서 "C:", "D:" 같은 패턴만 추출하여 배열로 반환
      const drives = stdout.match(/[A-Z]:/g) || [];
      return drives.map(d => d + '\\'); // ["C:\\", "D:\\", ...]
    } catch (e) {
      return ['C:\\']; // 실패 시 기본값
    }
  }
  return ['/']; // Mac/Linux 기본값
};

// ==========================================
// [1] 스캐너 유틸리티 (캐싱 폴더 탐색용)
// ==========================================
// 💡 수정: dir(폴더) 배열 추가
interface ScanResults { exe: string[]; bat: string[]; dir: string[]; lnk: string[]; url: string[]; }
const ensureDirectoryExists = (dirPath: string) => { if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true }); };

const categorizeFile = (filePath: string, results: ScanResults) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.exe') results.exe.push(filePath);
    else if (ext === '.bat') results.bat.push(filePath);
    else if (ext === '.lnk') results.lnk.push(filePath);
    else if (ext === '.url') results.url.push(filePath);
};

const scanDirectory = (currentDir: string, currentDepth = 1, maxDepth = 5, results: ScanResults = { exe: [], bat: [], dir: [], lnk: [], url: [] }, blacklistNames: string[] = [], blacklistPaths: string[] = []) => {
    if (currentDepth > maxDepth) return results;

    // 💡 1. 경로(Path) 기반 검사: 현재 경로가 블랙리스트 경로로 시작하면 통째로 스킵
    const normalizedCurrentDir = currentDir.toLowerCase().replace(/\\$/, '');
    if (blacklistPaths.some(p => normalizedCurrentDir.startsWith(p.toLowerCase().replace(/\\$/, '')))) return results;

    // 💡 2. 이름(Name) 기반 검사: 폴더 이름이 정확히 일치하면 스킵
    const folderName = path.basename(currentDir).toLowerCase();
    if (blacklistNames.some(b => b.toLowerCase() === folderName)) return results;

    try {
        for (const file of fs.readdirSync(currentDir)) {
            const fullPath = path.join(currentDir, file);
            try {
                if (fs.statSync(fullPath).isDirectory()) {
                    results.dir.push(fullPath);
                    scanDirectory(fullPath, currentDepth + 1, maxDepth, results, blacklistNames, blacklistPaths); 
                }
                else categorizeFile(fullPath, results);
            } catch (err) { continue; }
        }
    } catch (err) {}
    return results;
};

// ==========================================
// [2] 서버 환경 설정
// ==========================================
const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });
const outputDir = path.join(os.homedir(), '.freel_agent', 'path');
const exeOutputPath = path.join(outputDir, 'exe_results.txt');
const batOutputPath = path.join(outputDir, 'bat_results.txt');
const lnkOutputPath = path.join(outputDir, 'lnk_results.txt');
const urlOutputPath = path.join(outputDir, 'url_results.txt');
const dirOutputPath = path.join(outputDir, 'dir_results.txt');

// ==========================================
// [3] 액션 핸들러 (Action Handlers) 매핑
// ==========================================
const ActionHandlers: Record<string, (parameters: any) => Promise<any> | any> = {
  
  'filesystem_list': (parameters) => {
    const targetDir = parameters.path || './';
    return { path: targetDir, files: fs.readdirSync(targetDir) };
  },

  'system_execute': async (parameters) => {
    let cmd = parameters.command;

    // 1. AI가 따옴표를 임의로 붙여서 보냈을 경우를 대비해 깔끔하게 제거
    const cleanPath = cmd.replace(/^"|"$/g, '');

    // 2. 만약 전달받은 텍스트가 실제 디스크에 존재하는 파일/폴더 경로라면?
    if (fs.existsSync(cleanPath)) {
      // 윈도우 기본 실행 명령어인 start를 사용하여 띄어쓰기가 있어도 완벽하게 실행되도록 따옴표로 감쌈
      // 형식: start "" "C:\경로\파일 이름.url"
      cmd = `start "" "${cleanPath}"`;
    }

    console.log(`[Freel-Desktop] Executing: ${cmd}`);
    const { stdout, stderr } = await execAsync(cmd);
    
    return { 
      command: cmd, 
      stdout: stdout ? stdout.trim() : '', 
      stderr: stderr ? stderr.trim() : '' 
    };
  },

  'system_scan': async (parameters) => { 
    const maxDepth = parameters.depth || 5;
    const blacklistNames = parameters.blacklistNames || [];
    const blacklistPaths = parameters.blacklistPaths || [];
    
    ensureDirectoryExists(outputDir);
    
    let targetPaths = [parameters.path || 'ALL'];
    if (targetPaths[0] === 'ALL') {
        targetPaths = await getAvailableDrives();
        console.log(`[Freel-Desktop] 🔍 Auto-detected drives: ${targetPaths.join(', ')}`);
    }

    const combinedResults: ScanResults = { exe: [], bat: [], dir: [], lnk: [], url: [] };

    // 찾은 모든 드라이브를 하나씩 순회하며 스캔 진행
    for (const targetPath of targetPaths) {
        console.log(`[Freel-Desktop] 🔍 Scanning ${targetPath} (Depth: ${maxDepth})...`);
        scanDirectory(targetPath, 1, maxDepth, combinedResults, blacklistNames, blacklistPaths);
    }
    
    // 최종 결과를 캐시에 저장
    fs.writeFileSync(exeOutputPath, combinedResults.exe.join('\n'), 'utf-8');
    fs.writeFileSync(batOutputPath, combinedResults.bat.join('\n'), 'utf-8');
    fs.writeFileSync(dirOutputPath, combinedResults.dir.join('\n'), 'utf-8');
    fs.writeFileSync(lnkOutputPath, combinedResults.lnk.join('\n'), 'utf-8');
    fs.writeFileSync(urlOutputPath, combinedResults.url.join('\n'), 'utf-8');
    
    return { 
      message: `Scan complete for ${targetPaths.join(', ')}`, 
      exeSaved: combinedResults.exe.length, 
      batSaved: combinedResults.bat.length,
      dirSaved: combinedResults.dir.length,
      lnkSaved: combinedResults.lnk.length,
      urlSaved: combinedResults.url.length
    };
  },

  'find_application': (parameters) => {
    const keywords = Array.isArray(parameters.keywords) ? parameters.keywords.map((k: string) => k.toLowerCase()) : [String(parameters.keywords).toLowerCase()];
    const matchedPaths: string[] = [];
    const searchInFile = (filePath: string) => {
        if (fs.existsSync(filePath)) {
            const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
            for (const line of lines) {
                const cleanPath = line.trim();
                if (cleanPath && keywords.some((k: string) => path.basename(cleanPath).toLowerCase().includes(k))) {
                    matchedPaths.push(cleanPath);
                }
            }
        }
    };
    searchInFile(exeOutputPath);
    searchInFile(batOutputPath);
    searchInFile(lnkOutputPath);
    searchInFile(urlOutputPath);

    matchedPaths.sort((a, b) => a.length - b.length);
    
    return { 
      keywords, 
      matchedPaths: matchedPaths.slice(0, 5),
      totalMatches: matchedPaths.length 
    };
  },

  'find_directory': (parameters) => {
    const keywords = Array.isArray(parameters.keywords) ? parameters.keywords.map((k: string) => k.toLowerCase()) : [String(parameters.keywords).toLowerCase()];
    const matchedPaths: string[] = [];
    
    if (fs.existsSync(dirOutputPath)) {
        const lines = fs.readFileSync(dirOutputPath, 'utf-8').split('\n');
        for (const line of lines) {
            const cleanPath = line.trim();
            // 💡 1번 제외 (기존 some 유지: 키워드 중 하나라도 포함되면 결과에 담음)
            if (cleanPath && keywords.some((k: string) => path.basename(cleanPath).toLowerCase().includes(k))) {
                matchedPaths.push(cleanPath);
            }
        }
    }

    // 💡 2번 포함: 경로가 짧은 순(상위 폴더 우선)으로 정렬
    matchedPaths.sort((a, b) => a.length - b.length);

    return { 
      keywords, 
      matchedPaths: matchedPaths.slice(0, 5),
      // 💡 3번 포함: AI에게 검색된 총 개수 보고
      totalMatches: matchedPaths.length 
    };
  },

  'filesystem_write': (parameters) => {
    const dirPath = path.dirname(parameters.path);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(parameters.path, parameters.content, 'utf-8');
    return { message: `파일 저장 성공: ${parameters.path}` };
  },

  'filesystem_append': (parameters) => {
    if (!fs.existsSync(parameters.path)) throw new Error(`파일 찾을 수 없음: ${parameters.path}`);
    fs.appendFileSync(parameters.path, `\n${parameters.content}`, 'utf-8');
    return { message: `내용 추가 성공: ${parameters.path}` };
  },

  'filesystem_delete': (parameters) => {
    if (!fs.existsSync(parameters.path)) throw new Error(`삭제할 파일 없음: ${parameters.path}`);
    const stat = fs.statSync(parameters.path);
    if (stat.isDirectory()) fs.rmSync(parameters.path, { recursive: true, force: true });
    else fs.unlinkSync(parameters.path);
    return { message: `삭제 완료: ${parameters.path}` };
  }
};

// ==========================================
// [4] 웹소켓 통신 라우터
// ==========================================
console.log(`[Freel-Desktop] Background executor started on ws://localhost:${PORT}`);

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', async (message: string) => {
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(message);
      const { taskId, action, parameters } = parsedPayload;
      console.log(`\n[Freel-Desktop] 🚀 Task Received: ${action}`);

      if (!ActionHandlers[action]) throw new Error(`Unknown action: ${action}`);
      const resultData = await ActionHandlers[action](parameters);

      ws.send(JSON.stringify({ taskId, status: 'success', data: resultData, error: null }));
      console.log(`[Freel-Desktop] ✅ Task Completed: ${action}`);

    } catch (error) {
      console.error('[Freel-Desktop] ❌ Task failed:', error);
      ws.send(JSON.stringify({
        taskId: parsedPayload?.taskId || 'unknown',
        status: 'error', data: null,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  });
});