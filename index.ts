import fs from 'fs';
import path from 'path';
import os from 'os';

interface ScanResults {
    exe: string[];
    bat: string[];
}

const ensureDirectoryExists = (dirPath: string): void => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
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

const writeOutputFile = (filePaths: string[], outputPath: string): void => {
    fs.writeFileSync(outputPath, filePaths.join('\n'), 'utf-8');
};

const main = () => {
    // 터미널(또는 Rust)에서 넘겨준 인수들 가져오기 (예: "오버워치", "overwatch")
    const args = process.argv.slice(2);
    
    const userHomeDir = os.homedir(); 
    const outputDir = path.join(userHomeDir, '.freel_agent', 'path');
    const exeOutputPath = path.join(outputDir, 'exe_results.txt');
    const batOutputPath = path.join(outputDir, 'bat_results.txt');

    // [검색 모드]: 인수가 1개라도 전달된 경우
    if (args.length > 0) {
        // 모든 검색 키워드를 소문자로 통일
        const keywords = args.map(arg => arg.toLowerCase());
        const matchedPaths: string[] = [];

        const searchInFile = (filePath: string) => {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n');
                
                for (const line of lines) {
                    const cleanPath = line.trim();
                    if (!cleanPath) continue;
                    
                    // 파일명 자체만 추출해서 비교 (상위 폴더명에 우연히 포함된 것 방지)
                    const fileName = path.basename(cleanPath).toLowerCase();
                    
                    // 전달받은 키워드 중 하나라도 포함되어 있으면 결과에 추가
                    const isMatch = keywords.some(keyword => fileName.includes(keyword));
                    if (isMatch) {
                        matchedPaths.push(cleanPath);
                    }
                }
            }
        };

        searchInFile(exeOutputPath);
        searchInFile(batOutputPath);

        // Rust 프로그램이 캡처할 수 있도록 순수하게 경로들만 줄바꿈하여 출력
        matchedPaths.forEach(p => console.log(p));
        
        process.exit(0);
    } 
    // [탐색 모드]: 인수가 없는 경우 (기존 동작)
    else {
        const targetPath = 'C:\\'; 
        const maxDepth = 5;        

        console.log(`🔍 [${targetPath}] 탐색 시작...`);
        const foundFiles = scanDirectory(targetPath, 1, maxDepth);

        try {
            ensureDirectoryExists(outputDir);
            writeOutputFile(foundFiles.exe, exeOutputPath);
            writeOutputFile(foundFiles.bat, batOutputPath);
            console.log(`✅ 완료! EXE: ${foundFiles.exe.length}개, BAT: ${foundFiles.bat.length}개 저장됨`);
        } catch (error: any) {
            console.error(`❌ 오류: ${error.message}`);
        }
    }
};

main();