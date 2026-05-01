import { io } from 'socket.io-client';

export const initSocket = async () => {
    const options = {
        'force new connection': true,
        reconnectionAttempts: Infinity,
        timeout: 10000,
        transports: ['websocket'],
    };

    // In production (Render), frontend & backend are the same server.
    // In local dev, backend runs on :5000 separately.
    const serverUrl = process.env.REACT_APP_BACKEND_URL
        || (window.location.hostname === 'localhost'
            ? 'http://localhost:5000'
            : window.location.origin);

    return io(serverUrl, options);
};
