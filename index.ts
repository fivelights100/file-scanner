import fs from 'fs';
import path from 'path';
import os from 'os'; // 사용자 정보를 가져오기 위해 os 모듈 추가

// 탐색 결과를 담을 타입 정의
interface ScanResults {
    exe: string[];
    bat: string[];
}

// 역할 1: 디렉토리 관리 (결과를 저장할 폴더가 없으면 자동 생성)
const ensureDirectoryExists = (dirPath: string): void => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

// 역할 2: 파일 분류 로직
const categorizeFile = (filePath: string, results: ScanResults): void => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.exe') {
        results.exe.push(filePath);
    } else if (ext === '.bat') {
        results.bat.push(filePath);
    }
};

// 역할 3: 디렉토리 재귀 탐색 (탐색 깊이 제한 기능 유지)
const scanDirectory = (
    currentDir: string,
    currentDepth: number = 1,
    maxDepth: number = 5,
    results: ScanResults = { exe: [], bat: [] }
): ScanResults => {
    if (currentDepth > maxDepth) {
        return results;
    }

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
            } catch (err) {
                // 개별 파일 권한/접근 오류 무시
                continue;
            }
        }
    } catch (err) {
        // 폴더 권한/접근 오류 무시
    }

    return results;
};

// 역할 4: 결과 데이터 포맷팅 및 파일 저장
const writeOutputFile = (filePaths: string[], outputPath: string): void => {
    const fileContent = filePaths.join('\n');
    fs.writeFileSync(outputPath, fileContent, 'utf-8');
};

// 메인 실행 컨트롤러
const main = () => {
    const targetPath = 'C:\\'; 
    const maxDepth = 5;        

    // os.homedir()은 'C:\Users\현재사용자명'을 동적으로 반환합니다.
    const userHomeDir = os.homedir(); 
    const outputDir = path.join(userHomeDir, '.freel_agent', 'path');

    console.log(`🔍 [${targetPath}] 탐색 시작 (최대 깊이: ${maxDepth})...`);
    console.log(`(탐색 중입니다. 잠시만 기다려주세요.)`);

    // 탐색 실행
    const foundFiles = scanDirectory(targetPath, 1, maxDepth);

    try {
        // 저장 폴더 생성 (.freel_agent/path)
        ensureDirectoryExists(outputDir);

        // 결과 파일 경로 설정
        const exeOutputPath = path.join(outputDir, 'exe_results.txt');
        const batOutputPath = path.join(outputDir, 'bat_results.txt');

        // 파일 쓰기
        writeOutputFile(foundFiles.exe, exeOutputPath);
        writeOutputFile(foundFiles.bat, batOutputPath);

        console.log('\n=============================================');
        console.log(`✅ 파일 탐색 및 저장 완료!`);
        console.log(`📂 저장 폴더: ${outputDir}`);
        console.log(`  - EXE 파일: ${foundFiles.exe.length}개 저장됨 (exe_results.txt)`);
        console.log(`  - BAT 파일: ${foundFiles.bat.length}개 저장됨 (bat_results.txt)`);
        console.log('=============================================');
        
    } catch (error: any) {
        console.error(`\n❌ 시스템 오류 발생: ${error.message}`);
    }
};

main();