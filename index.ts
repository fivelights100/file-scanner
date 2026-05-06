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
interface ScanResults { 
    dir: string[]; 
    executable: string[]; 
    readable: string[]; 
}

const ensureDirectoryExists = (dirPath: string) => { if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true }); };

const categorizeFile = (filePath: string, results: ScanResults) => {
    const ext = path.extname(filePath).toLowerCase();
    
    // 실행 파일 그룹 (앱, 바로가기, 배치파일 등)
    const execExts = ['.exe', '.bat', '.cmd', '.lnk', '.url'];
    // 읽기 가능한 파일 그룹 (문서, 코드, 설정파일 등)
    const readExts = ['.txt', '.md', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.env', '.log', '.xml', '.yml', '.yaml', '.ini', '.conf'];

    if (execExts.includes(ext)) {
        results.executable.push(filePath);
    } else if (readExts.includes(ext)) {
        results.readable.push(filePath);
    } 
    // 그 외의 거대한 바이너리 파일(.mp4, .dll, .iso 등)은 스캔은 하되 메모리 최적화를 위해 캐싱하지 않습니다.
};

const scanDirectory = (
    currentDir: string, 
    currentDepth = 1, 
    maxDepth = 10, // 💡 기본값을 5에서 10으로 변경
    results: ScanResults = { dir: [], executable: [], readable: [] }, // 💡 3가지 통합 구조로 변경
    blacklistNames: string[] = [], 
    blacklistPaths: string[] = []
) => {
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
const dirOutputPath = path.join(outputDir, 'dir_results.txt');
const executableOutputPath = path.join(outputDir, 'executable_results.txt');
const readableOutputPath = path.join(outputDir, 'readable_results.txt');
const memoryFilePath = path.join(outputDir, 'memory.json');

// 💡 기억 저장소 읽기/쓰기 유틸리티
const readMemory = (): Record<string, any> => {
    if (!fs.existsSync(memoryFilePath)) return {};
    try { return JSON.parse(fs.readFileSync(memoryFilePath, 'utf-8')); }
    catch { return {}; }
};
const writeMemory = (data: Record<string, any>) => {
    ensureDirectoryExists(outputDir);
    fs.writeFileSync(memoryFilePath, JSON.stringify(data, null, 2), 'utf-8');
};

// ==========================================
// [3] 액션 핸들러 (Action Handlers) 매핑
// ==========================================
const ActionHandlers: Record<string, (parameters: any) => Promise<any> | any> = {
  
  'memory_update': (parameters) => {
    const { category, key, value } = parameters;
    const memory = readMemory();
    
    if (!memory[category]) memory[category] = {};
    
    const existingValue = memory[category][key];
    
    if (existingValue) {
        // 이미 배열인 경우: 중복 확인 후 추가
        if (Array.isArray(existingValue)) {
            if (!existingValue.includes(value)) existingValue.push(value);
        } 
        // 기존 값이 단일 값(문자열 등)이고 새로운 값과 다른 경우: 배열로 변환
        else if (existingValue !== value) {
            memory[category][key] = [existingValue, value];
        }
    } else {
        // 처음 저장되는 값
        memory[category][key] = value;
    }
    
    writeMemory(memory);
    return { 
      message: `[기억 백그라운드 병합 완료] ${category} -> ${key}` 
    };
  },

  // 💡 기억 불러오기
  'memory_retrieve': (parameters) => {
    const memory = readMemory();
    const category = parameters.category;
    
    if (category) {
        return memory[category] ? { category, data: memory[category] } : { message: `해당 카테고리(${category})의 기억이 없습니다.` };
    }
    return { message: "전체 기억 로드 완료", data: memory };
  },

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
    const maxDepth = parameters.depth || 10;
    const blacklistNames = parameters.blacklistNames || [];
    
    // 💡 1. 절대 지울 수 없는 고정 블랙리스트 경로 배열 생성
    const fixedBlacklistPaths = ['C:\\Windows', 'C:\\inetpub'];
    
    // 💡 2. AI(프론트엔드)가 보낸 블랙리스트와 고정 블랙리스트를 병합
    const blacklistPaths = [...(parameters.blacklistPaths || []), ...fixedBlacklistPaths];
    
    ensureDirectoryExists(outputDir);
    
    let targetPaths = [parameters.path || 'ALL'];
    if (targetPaths[0] === 'ALL') {
        targetPaths = await getAvailableDrives();
        console.log(`[Freel-Desktop] 🔍 Auto-detected drives: ${targetPaths.join(', ')}`);
    }

    const combinedResults: ScanResults = { dir: [], executable: [], readable: [] };

    for (const targetPath of targetPaths) {
        console.log(`[Freel-Desktop] 🔍 Scanning ${targetPath} (Depth: ${maxDepth})...`);
        // 병합된 blacklistPaths가 scanDirectory 함수로 안전하게 전달됨
        scanDirectory(targetPath, 1, maxDepth, combinedResults, blacklistNames, blacklistPaths);
    }
    
    fs.writeFileSync(dirOutputPath, combinedResults.dir.join('\n'), 'utf-8');
    fs.writeFileSync(executableOutputPath, combinedResults.executable.join('\n'), 'utf-8');
    fs.writeFileSync(readableOutputPath, combinedResults.readable.join('\n'), 'utf-8');
    
    return { 
      message: `Scan complete for ${targetPaths.join(', ')} (Depth: ${maxDepth})`, 
      dirSaved: combinedResults.dir.length,
      executableSaved: combinedResults.executable.length,
      readableSaved: combinedResults.readable.length
    };
  },

  // 💡 기존 find_application을 대체하는 실행 파일 검색 도구
  'find_executable': (parameters) => {
    const keywords = Array.isArray(parameters.keywords) ? parameters.keywords.map((k: string) => k.toLowerCase()) : [String(parameters.keywords).toLowerCase()];
    const matchedPaths: string[] = [];
    
    if (fs.existsSync(executableOutputPath)) {
        const lines = fs.readFileSync(executableOutputPath, 'utf-8').split('\n');
        for (const line of lines) {
            const cleanPath = line.trim();
            if (cleanPath && keywords.some((k: string) => path.basename(cleanPath).toLowerCase().includes(k))) {
                matchedPaths.push(cleanPath);
            }
        }
    }
    matchedPaths.sort((a, b) => a.length - b.length);
    return { keywords, matchedPaths: matchedPaths.slice(0, 5), totalMatches: matchedPaths.length };
  },

  // 💡 텍스트/문서 파일을 찾는 도구
  'find_readable': (parameters) => {
    const keywords = Array.isArray(parameters.keywords) ? parameters.keywords.map((k: string) => k.toLowerCase()) : [String(parameters.keywords).toLowerCase()];
    const matchedPaths: string[] = [];
    
    if (fs.existsSync(readableOutputPath)) {
        const lines = fs.readFileSync(readableOutputPath, 'utf-8').split('\n');
        for (const line of lines) {
            const cleanPath = line.trim();
            if (cleanPath && keywords.some((k: string) => path.basename(cleanPath).toLowerCase().includes(k))) {
                matchedPaths.push(cleanPath);
            }
        }
    }
    matchedPaths.sort((a, b) => a.length - b.length);
    return { keywords, matchedPaths: matchedPaths.slice(0, 5), totalMatches: matchedPaths.length };
  },

  'find_directory': (parameters) => {
    const keywords = Array.isArray(parameters.keywords) ? parameters.keywords.map((k: string) => k.toLowerCase()) : [String(parameters.keywords).toLowerCase()];
    const matchedPaths: string[] = [];
    
    if (fs.existsSync(dirOutputPath)) {
        const lines = fs.readFileSync(dirOutputPath, 'utf-8').split('\n');
        for (const line of lines) {
            const cleanPath = line.trim();
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

  'filesystem_read': (parameters) => {
    if (!fs.existsSync(parameters.path)) {
      throw new Error(`파일을 찾을 수 없습니다: ${parameters.path}`);
    }
    
    const stat = fs.statSync(parameters.path);
    if (stat.isDirectory()) {
      throw new Error(`해당 경로는 폴더입니다. 텍스트 파일의 경로를 입력해주세요: ${parameters.path}`);
    }
    
    // AI 컨텍스트 초과 방지를 위한 안전장치 (예: 2MB 이상의 파일은 거부)
    const MAX_FILE_SIZE = 2 * 1024 * 1024; 
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(`파일 용량이 너무 커서 읽을 수 없습니다. (최대 2MB 허용)`);
    }

    const content = fs.readFileSync(parameters.path, 'utf-8');
    
    return { 
      message: `파일 읽기 성공 (${content.length} bytes)`,
      path: parameters.path, 
      content: content 
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