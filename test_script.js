import fs from 'fs';
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:9090');

ws.on('open', () => {
  console.log('Connected to backend');
  
  const nodes = [
    {
      "id": "net1",
      "type": "createNet",
      "config": {
        "vendor": "ncnn",
        "paramPath": "demo/NCNN_demo/shufflenet.param",
        "modelPath": "",
        "emptyWeights": "true",
        "inputName": "data",
        "outputName": "output",
        "inputW": "224",
        "inputH": "224",
        "inputC": "3",
        "numThreads": "2"
      }
    },
    {
      "id": "input1",
      "type": "inputTensor",
      "config": {
        "fillMode": "manual",
        "tensorText": "1.0, 1.0, 1.0, 1.0"
      }
    },
    {
      "id": "infer1",
      "type": "inference",
      "config": {}
    },
    {
      "id": "out1",
      "type": "output",
      "config": {}
    }
  ];
  
  const edges = [
    { "source": "net1", "sourceHandle": "net_handle", "target": "infer1", "targetHandle": "net_handle" },
    { "source": "input1", "sourceHandle": "tensor_data", "target": "infer1", "targetHandle": "input_data" },
    { "source": "infer1", "sourceHandle": "output_data", "target": "out1", "targetHandle": "data" }
  ];

  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'workflow.execute',
    params: { nodes, edges }
  }));
});

let output1 = null;

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === 'node.status' && msg.params.node_id === 'out1') {
    if (msg.params.output) {
      output1 = msg.params.output;
      console.log('Run 1 output:', output1.slice(0, 5));
    }
  }
  
  if (msg.method === 'workflow.complete') {
    console.log('Run 1 complete. Now changing input to all 5.0...');
    
    const nodes2 = [
      {
        "id": "net1",
        "type": "createNet",
        "config": {
          "vendor": "ncnn",
          "paramPath": "demo/NCNN_demo/shufflenet.param",
          "modelPath": "",
          "emptyWeights": "true",
          "inputName": "data",
          "outputName": "output",
          "inputW": "224",
          "inputH": "224",
          "inputC": "3",
          "numThreads": "2"
        }
      },
      {
        "id": "input1",
        "type": "inputTensor",
        "config": {
          "fillMode": "manual",
          "tensorText": "5.0, 5.0, 5.0, 5.0"
        }
      },
      {
        "id": "infer1",
        "type": "inference",
        "config": {}
      },
      {
        "id": "out2",
        "type": "output",
        "config": {}
      }
    ];
    
    const edges2 = [
      { "source": "net1", "sourceHandle": "net_handle", "target": "infer1", "targetHandle": "net_handle" },
      { "source": "input1", "sourceHandle": "tensor_data", "target": "infer1", "targetHandle": "input_data" },
      { "source": "infer1", "sourceHandle": "output_data", "target": "out2", "targetHandle": "data" }
    ];
    
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'workflow.execute',
      params: { nodes: nodes2, edges: edges2 }
    }));
  }
  
  if (msg.method === 'node.status' && msg.params.node_id === 'out2') {
    if (msg.params.output) {
      console.log('Run 2 output:', msg.params.output.slice(0, 5));
      ws.close();
    }
  }
});
