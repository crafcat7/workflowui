#!/bin/bash
# Start backend
echo "Starting C++ Backend Server..."
./backend/build/workflow_backend &
BACKEND_PID=$!

# Start frontend
echo "Starting React Frontend..."
cd frontend && npm run dev &
FRONTEND_PID=$!

echo ""
echo "Servers are running."
echo "Frontend: http://localhost:5173"
echo "Backend WebSocket: ws://127.0.0.1:9090"
echo "Press Ctrl+C to stop both servers."

# Wait for user interrupt
trap "kill $BACKEND_PID $FRONTEND_PID" INT TERM EXIT
wait
