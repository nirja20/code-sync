const express = require('express');
const app = express();
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const ACTIONS = require('./src/Actions');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"],
        credentials: true
    }
});

app.use(express.static('build'));
app.use((req, res, next) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

const userSocketMap = {};
const roomPermissionMap = {};
const socketRoomMap = {};

// Store active processes for each room
const activeProcesses = {};

// Persist room code and language so they survive refreshes
const roomCodeMap = {};  // { roomId: { code: string, language: string } }

// ── Cross-platform GCC/G++ resolver ─────────────────────────────────────────
// On Linux (Render, Ubuntu) gcc/g++ are already in PATH.
// On Windows we scan common MinGW / MSYS2 install locations and pick the first
// one that actually contains gcc.exe, then inject it into child-process envs.
const IS_WIN = process.platform === 'win32';

function findWindowsGccBin() {
    const candidates = [
        'C:\\msys64\\ucrt64\\bin',
        'C:\\msys64\\mingw64\\bin',
        'C:\\msys64\\mingw32\\bin',
        'C:\\mingw64\\bin',
        'C:\\mingw32\\bin',
        'C:\\TDM-GCC-64\\bin',
        'C:\\Program Files\\mingw-w64\\x86_64-8.1.0-posix-seh-rt_v6-rev0\\mingw64\\bin',
    ];
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'gcc.exe'))) {
            return dir;
        }
    }
    return null; // fall back to whatever is already in PATH
}

const WIN_GCC_BIN = IS_WIN ? findWindowsGccBin() : null;

// Returns the compiler command name/path and an augmented env for child processes
function getCompilerEnv() {
    if (!IS_WIN || !WIN_GCC_BIN) {
        return { extraPath: null, env: process.env };
    }
    const augmentedPath = WIN_GCC_BIN + ';' + process.env.PATH;
    return {
        extraPath: WIN_GCC_BIN,
        env: { ...process.env, PATH: augmentedPath },
    };
}

function gccCmd()  { return IS_WIN && WIN_GCC_BIN ? path.join(WIN_GCC_BIN, 'gcc.exe') : 'gcc'; }
function gppCmd()  { return IS_WIN && WIN_GCC_BIN ? path.join(WIN_GCC_BIN, 'g++.exe') : 'g++'; }
// ─────────────────────────────────────────────────────────────────────────────

// Code execution function with interactive I/O
function executeCode(code, language, roomId, io) {
    const tempDir = os.tmpdir();
    const timestamp = Date.now();
    let fileName, command, args = [];

    try {
        switch (language.toLowerCase()) {
            case 'python':
                fileName = path.join(tempDir, `code_${timestamp}.py`);
                fs.writeFileSync(fileName, code, { encoding: 'utf8' });
                command = 'python';
                args = ['-u', fileName];
                break;

            case 'javascript':
                fileName = path.join(tempDir, `code_${timestamp}.js`);
                
                // Add prompt/alert/confirm polyfill for Node.js
                const polyfill = `
// Browser function polyfills for Node.js
const readline = require('readline');
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Store original question function
const originalQuestion = rl.question.bind(rl);

// Synchronous-style prompt using promises
global.prompt = function(message) {
    return new Promise((resolve) => {
        originalQuestion(message, (answer) => {
            resolve(answer);
        });
    });
};

global.alert = function(message) {
    console.log(message);
};

global.confirm = function(message) {
    return new Promise((resolve) => {
        originalQuestion(message + ' (yes/no): ', (answer) => {
            resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
        });
    });
};

// Wrap user code in async function to use await with prompt
(async function() {
try {
// ==== USER CODE STARTS HERE ====
`;
                
                const codeWrapper = `
// ==== USER CODE ENDS HERE ====
} catch (error) {
    console.error(error.message);
} finally {
    rl.close();
}
})();
`;
                
                const wrappedCode = polyfill + code + codeWrapper;
                fs.writeFileSync(fileName, wrappedCode, { encoding: 'utf8' });
                command = 'node';
                args = [fileName];
                break;

            case 'java':
                const classMatch = code.match(/public\s+class\s+(\w+)/);
                const className = classMatch ? classMatch[1] : 'Main';
                fileName = path.join(tempDir, `${className}.java`);
                fs.writeFileSync(fileName, code, { encoding: 'utf8' });
                
                // First compile
                const { execSync } = require('child_process');
                try {
                    execSync(`javac -encoding UTF-8 "${fileName}"`, { 
                        cwd: tempDir,
                        encoding: 'utf8'
                    });
                    command = 'java';
                    args = ['-cp', tempDir, className];
                } catch (compileError) {
                    io.in(roomId).emit(ACTIONS.CODE_ERROR, {
                        output: compileError.stderr || compileError.message,
                    });
                    return;
                }
                break;

            case 'cpp':
            case 'c++': {
                const { env: cppEnv } = getCompilerEnv();
                const outputFile = path.join(tempDir, `code_${timestamp}.exe`);
                fileName = path.join(tempDir, `code_${timestamp}.cpp`);
                fs.writeFileSync(fileName, code, { encoding: 'utf8' });
                try {
                    const { execSync } = require('child_process');
                    execSync(`"${gppCmd()}" "${fileName}" -o "${outputFile}"`, {
                        encoding: 'utf8',
                        env: cppEnv,
                    });
                    command = outputFile;
                    args = [];
                } catch (compileError) {
                    io.in(roomId).emit(ACTIONS.CODE_ERROR, {
                        output: compileError.stderr || compileError.message,
                    });
                    return;
                }
                break;
            }

            case 'c': {
                const { env: cEnv } = getCompilerEnv();
                const outputFileC = path.join(tempDir, `code_${timestamp}.exe`);
                fileName = path.join(tempDir, `code_${timestamp}.c`);
                fs.writeFileSync(fileName, code, { encoding: 'utf8' });
                try {
                    const { execSync } = require('child_process');
                    execSync(`"${gccCmd()}" "${fileName}" -o "${outputFileC}"`, {
                        encoding: 'utf8',
                        env: cEnv,
                    });
                    command = outputFileC;
                    args = [];
                } catch (compileError) {
                    io.in(roomId).emit(ACTIONS.CODE_ERROR, {
                        output: compileError.stderr || compileError.message,
                    });
                    return;
                }
                break;
            }

            default:
                io.in(roomId).emit(ACTIONS.CODE_ERROR, {
                    output: `Unsupported language: ${language}`,
                });
                return;
        }

        // Spawn the process for interactive I/O
        const { spawn } = require('child_process');
        const { env: spawnEnv } = getCompilerEnv();
        const childProcess = spawn(command, args, {
            env: { 
                ...spawnEnv,
                PYTHONIOENCODING: 'utf-8',
                NODE_NO_WARNINGS: '1'
            },
            shell: false
        });

        // Store the process so we can send input to it later
        activeProcesses[roomId] = {
            process: childProcess,
            fileName: fileName,
            language: language
        };

        // Stream stdout to client
        childProcess.stdout.on('data', (data) => {
            io.in(roomId).emit(ACTIONS.CODE_OUTPUT, {
                output: data.toString('utf8'),
            });
        });

        // Stream stderr to client
        childProcess.stderr.on('data', (data) => {
            io.in(roomId).emit(ACTIONS.CODE_ERROR, {
                output: data.toString('utf8'),
            });
        });

        // Handle process completion
        childProcess.on('close', (code) => {
            // Clean up files
            try {
                if (fs.existsSync(fileName)) {
                    fs.unlinkSync(fileName);
                }
                // Clean up Java class files
                if (language.toLowerCase() === 'java') {
                    const classMatch = code.match(/public\s+class\s+(\w+)/);
                    const className = classMatch ? classMatch[1] : 'Main';
                    const classFile = path.join(tempDir, `${className}.class`);
                    if (fs.existsSync(classFile)) {
                        fs.unlinkSync(classFile);
                    }
                }
                // Clean up executables
                if (language.toLowerCase() === 'cpp' || language.toLowerCase() === 'c++' || language.toLowerCase() === 'c') {
                    const exeFile = language.toLowerCase() === 'c' 
                        ? path.join(tempDir, `code_${timestamp}.exe`)
                        : path.join(tempDir, `code_${timestamp}.exe`);
                    if (fs.existsSync(exeFile)) {
                        fs.unlinkSync(exeFile);
                    }
                }
            } catch (cleanupError) {
                console.error('Cleanup error:', cleanupError);
            }

            delete activeProcesses[roomId];
            
            io.in(roomId).emit(ACTIONS.EXECUTION_COMPLETE, {
                exitCode: code,
            });
        });

        // Handle errors
        childProcess.on('error', (error) => {
            if (error.code === 'ENOENT') {
                io.in(roomId).emit(ACTIONS.CODE_ERROR, {
                    output: `Error: ${language} is not installed or not in PATH.\nPlease install ${language} and try again.`,
                });
            } else {
                io.in(roomId).emit(ACTIONS.CODE_ERROR, {
                    output: error.message,
                });
            }
            delete activeProcesses[roomId];
        });

        // Set timeout
        setTimeout(() => {
            if (activeProcesses[roomId]) {
                childProcess.kill();
                io.in(roomId).emit(ACTIONS.CODE_ERROR, {
                    output: '\n\nExecution timeout (10 seconds exceeded)',
                });
                delete activeProcesses[roomId];
            }
        }, 10000);

    } catch (error) {
        io.in(roomId).emit(ACTIONS.CODE_ERROR, {
            output: `Error: ${error.message}`,
        });
    }
}

// Send input to running process
function sendInputToProcess(roomId, input) {
    if (activeProcesses[roomId] && activeProcesses[roomId].process) {
        activeProcesses[roomId].process.stdin.write(input + '\n');
    }
}


function getAllConnectedClients(roomId) {
    // Map
    return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
        (socketId) => {
            return {
                socketId,
                username: userSocketMap[socketId],
                role: hasEditPermission(roomId, socketId) ? 'editor' : 'viewer',
            };
        }
    );
}

function initializeRoomPermissions(roomId, socketId, username) {
    if (!roomPermissionMap[roomId]) {
        // First user to create the room becomes owner and editor
        roomPermissionMap[roomId] = {
            ownerSocketId: socketId,
            ownerUsername: username,
            editorSocketIds: new Set([socketId]),
            editorUsernames: new Set([username]),
        };
        return;
    }
    // Room already exists — restore role from username if this user was previously an editor/owner
    const roomPermissions = roomPermissionMap[roomId];
    if (!roomPermissions.editorSocketIds) {
        roomPermissions.editorSocketIds = new Set();
    }
    if (!roomPermissions.editorUsernames) {
        roomPermissions.editorUsernames = new Set();
    }

    // If the rejoining user was previously an editor (by username), restore their socket ID
    if (roomPermissions.editorUsernames.has(username)) {
        roomPermissions.editorSocketIds.add(socketId);
    }

    // If the rejoining user was the owner, restore their owner socket ID
    if (roomPermissions.ownerUsername === username) {
        roomPermissions.ownerSocketId = socketId;
    }
}

function hasEditPermission(roomId, socketId) {
    const roomPermissions = roomPermissionMap[roomId];
    if (!roomPermissions) {
        return false;
    }
    return roomPermissions.editorSocketIds.has(socketId);
}

function cleanupRoomPermissions(roomId) {
    const clients = io.sockets.adapter.rooms.get(roomId);
    if (!clients || clients.size === 0) {
        delete roomPermissionMap[roomId];
        delete roomCodeMap[roomId];
    }
}

function emitPermissionDenied(socket, message) {
    socket.emit(ACTIONS.PERMISSION_DENIED, {
        message,
    });
}

io.on('connection', (socket) => {
    console.log('socket connected', socket.id);

    socket.on(ACTIONS.JOIN, ({ roomId, username }) => {
        userSocketMap[socket.id] = username;
        socketRoomMap[socket.id] = roomId;
        // Pass username so the server can restore the role on refresh
        initializeRoomPermissions(roomId, socket.id, username);
        socket.join(roomId);
        const clients = getAllConnectedClients(roomId);
        const { ownerSocketId } = roomPermissionMap[roomId];
        // Get saved code and language for this room (if any)
        const savedCode = roomCodeMap[roomId]?.code ?? null;
        const savedLanguage = roomCodeMap[roomId]?.language ?? null;
        clients.forEach(({ socketId }) => {
            io.to(socketId).emit(ACTIONS.JOINED, {
                clients,
                username,
                socketId: socket.id,
                ownerSocketId,
                // Send saved state only to the joining socket so others aren't disrupted
                code: socketId === socket.id ? savedCode : undefined,
                language: socketId === socket.id ? savedLanguage : undefined,
            });
        });
    });

    socket.on(ACTIONS.CODE_CHANGE, ({ roomId, code }) => {
        if (!hasEditPermission(roomId, socket.id)) {
            emitPermissionDenied(socket, 'You do not have permission to edit code.');
            return;
        }
        // Persist the latest code for this room
        if (!roomCodeMap[roomId]) roomCodeMap[roomId] = {};
        roomCodeMap[roomId].code = code;
        socket.in(roomId).emit(ACTIONS.CODE_CHANGE, { code });
    });

    socket.on(ACTIONS.SYNC_CODE, ({ socketId, code, roomId }) => {
        if (roomId && !hasEditPermission(roomId, socket.id)) {
            emitPermissionDenied(socket, 'You do not have permission to sync code.');
            return;
        }
        io.to(socketId).emit(ACTIONS.CODE_CHANGE, { code });
    });

    socket.on(ACTIONS.CURSOR_POSITION, ({ roomId, cursorData }) => {
        socket.in(roomId).emit(ACTIONS.CURSOR_POSITION, {
            socketId: socket.id,
            username: userSocketMap[socket.id],
            cursorData,
        });
    });

    socket.on(ACTIONS.LANGUAGE_CHANGE, ({ roomId, language }) => {
        if (!hasEditPermission(roomId, socket.id)) {
            emitPermissionDenied(socket, 'You do not have permission to change language.');
            return;
        }
        // Persist the selected language for this room
        if (!roomCodeMap[roomId]) roomCodeMap[roomId] = {};
        roomCodeMap[roomId].language = language;
        socket.in(roomId).emit(ACTIONS.LANGUAGE_CHANGE, { language });
    });

    socket.on(ACTIONS.RUN_CODE, ({ roomId, code, language }) => {
        if (!hasEditPermission(roomId, socket.id)) {
            emitPermissionDenied(socket, 'You do not have permission to run code.');
            return;
        }
        executeCode(code, language, roomId, io);
    });

    socket.on(ACTIONS.SEND_INPUT, ({ roomId, input }) => {
        if (!hasEditPermission(roomId, socket.id)) {
            emitPermissionDenied(socket, 'You do not have permission to send input.');
            return;
        }
        sendInputToProcess(roomId, input);
    });

    socket.on(ACTIONS.PROMOTE_TO_EDITOR, ({ roomId, targetSocketId }) => {
        const roomPermissions = roomPermissionMap[roomId];
        if (!roomPermissions) {
            return;
        }

        if (roomPermissions.ownerSocketId !== socket.id) {
            emitPermissionDenied(socket, 'Only the room editor can promote viewers.');
            return;
        }

        const roomClients = io.sockets.adapter.rooms.get(roomId);
        if (!roomClients || !roomClients.has(targetSocketId)) {
            return;
        }

        if (targetSocketId === roomPermissions.ownerSocketId) {
            emitPermissionDenied(socket, 'Room editor role cannot be changed.');
            return;
        }

        const isCurrentlyEditor = roomPermissions.editorSocketIds.has(targetSocketId);
        const targetUsername = userSocketMap[targetSocketId];

        if (isCurrentlyEditor) {
            roomPermissions.editorSocketIds.delete(targetSocketId);
            // Also remove from persistent username set so role is not restored on next refresh
            if (targetUsername) {
                roomPermissions.editorUsernames.delete(targetUsername);
            }
        } else {
            roomPermissions.editorSocketIds.add(targetSocketId);
            // Persist to username set so role survives a refresh
            if (targetUsername) {
                roomPermissions.editorUsernames.add(targetUsername);
            }
        }

        io.in(roomId).emit(ACTIONS.ROLE_UPDATED, {
            socketId: targetSocketId,
            role: isCurrentlyEditor ? 'viewer' : 'editor',
        });
    });

    socket.on('disconnecting', () => {
        const rooms = [...socket.rooms];
        rooms.forEach((roomId) => {
            socket.in(roomId).emit(ACTIONS.DISCONNECTED, {
                socketId: socket.id,
                username: userSocketMap[socket.id],
            });

            const roomPermissions = roomPermissionMap[roomId];
            if (roomPermissions) {
                // Remove the stale socket ID but keep the username-based role
                // so the user can rejoin (refresh) and get their role back
                roomPermissions.editorSocketIds.delete(socket.id);
                // Do NOT clear ownerSocketId here — it will be restored on rejoin
            }
        });
        delete userSocketMap[socket.id];
        socket.leave();
    });

    socket.on('disconnect', () => {
        const roomId = socketRoomMap[socket.id];
        if (roomId) {
            cleanupRoomPermissions(roomId);
        }
        delete socketRoomMap[socket.id];
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
