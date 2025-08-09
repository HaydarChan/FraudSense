import { useState, useRef, useEffect } from 'react';

const VideoCall = ({ socket, callData, user, onEndCall }) => {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callAccepted, setCallAccepted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [localAudioLevel, setLocalAudioLevel] = useState(0);
  const [remoteAudioLevel, setRemoteAudioLevel] = useState(0);
  const [audioFormat, setAudioFormat] = useState('webm');
  const [isRecording, setIsRecording] = useState(false);

  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const peerConnectionRef = useRef(null);
  const remoteMediaStreamRef = useRef(null);
  const pendingRemoteIceCandidatesRef = useRef([]);
  const localAudioContextRef = useRef(null);
  const remoteAudioContextRef = useRef(null);
  const localAnalyserRef = useRef(null);
  const remoteAnalyserRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const initializedRef = useRef(false);
  const hasCleanedUpRef = useRef(false);

  useEffect(() => {
    // Guard against React 18 StrictMode double-invoke in dev
    if (!initializedRef.current) {
      initializedRef.current = true;
      initializeCall();
    }
    return () => {
      cleanup();
    };
  }, []);

  useEffect(() => {
    // Set up socket listeners
    console.log('🔌 Setting up socket listeners');
    socket.on('call-answer', handleCallAnswer);
    socket.on('call-ended', handleCallEnded);
    socket.on('ice-candidate', handleIceCandidate);
    
    return () => {
      console.log('🔌 Cleaning up socket listeners');
      socket.off('call-answer', handleCallAnswer);
      socket.off('call-ended', handleCallEnded);
      socket.off('ice-candidate', handleIceCandidate);
    };
  }, []);

  // Handle local stream attachment to video element
  useEffect(() => {
    if (localStream && localVideoRef.current) {
      console.log('✅ Attaching local stream to video element');
      localVideoRef.current.srcObject = localStream;
      
      // Add video element event listeners
      const videoElement = localVideoRef.current;
      videoElement.addEventListener('loadstart', () => console.log('📺 Local video load start'));
      videoElement.addEventListener('loadeddata', () => console.log('📺 Local video data loaded'));
      videoElement.addEventListener('canplay', () => console.log('📺 Local video can play'));
      videoElement.addEventListener('playing', () => console.log('📺 Local video playing'));
      videoElement.addEventListener('error', (e) => console.log('📺 Local video error:', e));
      
      // Start playing the video
      videoElement.play().catch(e => console.error('Local video play failed:', e));
    }
  }, [localStream]);

  // Handle remote stream attachment to video element
  useEffect(() => {
    if (remoteStream && remoteVideoRef.current) {
      console.log('✅ Attaching remote stream to video element');
      remoteVideoRef.current.srcObject = remoteStream;
      
      // Add video element event listeners
      const videoElement = remoteVideoRef.current;
      videoElement.addEventListener('loadstart', () => console.log('📺 Remote video load start'));
      videoElement.addEventListener('loadeddata', () => console.log('📺 Remote video data loaded'));
      videoElement.addEventListener('canplay', () => console.log('📺 Remote video can play'));
      videoElement.addEventListener('playing', () => console.log('📺 Remote video playing'));
      videoElement.addEventListener('error', (e) => console.log('📺 Remote video error:', e));
      
      // Start playing the video
      videoElement.play().catch(e => console.error('Remote video play failed:', e));
    }
  }, [remoteStream]);

  const initializeCall = async () => {
    try {
      console.log('🚀 Initializing call:', callData);
      
      // Check if we're in a secure context
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('MediaDevices API not available. Please use HTTPS or localhost.');
      }

      // Get user media
      console.log('📹 Requesting media access...');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: true
      });
      
      console.log('✅ Media access granted, tracks:', stream.getTracks().length);
      
      // Log detailed track information
      stream.getTracks().forEach((track, index) => {
        console.log(`Track ${index}:`, {
          kind: track.kind,
          enabled: track.enabled,
          readyState: track.readyState,
          muted: track.muted,
          constraints: track.getConstraints(),
          settings: track.getSettings()
        });
      });
      
      setLocalStream(stream);
      
      // Set up audio level monitoring for local stream
      setupAudioLevelMonitoring(stream, 'local');
      
      // Set up audio recording for fraud detection
      setupAudioRecording(stream);

      // Get TURN configuration from backend
      console.log('🧊 Requesting TURN configuration from backend...');
      let rtcConfig = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' }
        ]
      };

      try {
        // Request TURN config from backend
        const turnConfig = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('TURN config timeout')), 5000);
          socket.emit('get-turn-config', (config) => {
            clearTimeout(timeout);
            resolve(config);
          });
        });

        if (turnConfig && turnConfig.iceServers) {
          rtcConfig = turnConfig;
          console.log('✅ Using TURN configuration from backend:', rtcConfig);
        }
      } catch (error) {
        console.warn('⚠️ Failed to get TURN config from backend, using fallback:', error);
        
        // Fallback to environment variables
        const turnUrl = import.meta.env.VITE_TURN_SERVER;
        const turnSecret = import.meta.env.VITE_TURN_SECRET;
        const turnRealm = import.meta.env.VITE_TURN_REALM || 'fraudsense.local';
        
        if (turnUrl && turnSecret) {
          rtcConfig.iceServers.push({
            urls: [`turn:${turnUrl}?transport=udp`],
            username: 'temp-user',
            credential: turnSecret,
            credentialType: 'password'
          });
          rtcConfig.iceServers.push({
            urls: [`turn:${turnUrl}?transport=tcp`],
            username: 'temp-user',
            credential: turnSecret,
            credentialType: 'password'
          });
          console.log('🧊 Using TURN server from environment variables');
        }
      }

      const forceRelayOnly = import.meta.env.VITE_ICE_RELAY_ONLY === '1';
      if (forceRelayOnly) {
        rtcConfig.iceTransportPolicy = 'relay';
        console.log('🧊 Forcing relay-only via TURN for connectivity testing');
      }
      
      const pc = new RTCPeerConnection(rtcConfig);

      // Add connection state logging
      pc.onconnectionstatechange = () => {
        console.log('🔗 Connection state:', pc.connectionState);
      };

      pc.oniceconnectionstatechange = () => {
        console.log('🧊 ICE connection state:', pc.iceConnectionState);
      };

      pc.onicegatheringstatechange = () => {
        console.log('🔍 ICE gathering state:', pc.iceGatheringState);
      };

      pc.onicecandidateerror = (event) => {
        console.warn('🧊 ICE candidate error:', {
          errorCode: event.errorCode,
          errorText: event.errorText,
          url: event.url
        });
      };

      // Add local stream to peer connection
      console.log('📤 Adding local tracks to peer connection...');
      stream.getTracks().forEach((track, index) => {
        console.log(`Adding track ${index}:`, track.kind, track.enabled);
        pc.addTrack(track, stream);
      });

      // Handle remote tracks using a persistent MediaStream (more robust across browsers)
      pc.ontrack = (event) => {
        console.log('📥 Received remote track:', event.track.kind, {
          hasStreamsArray: Array.isArray(event.streams),
          streamsLength: event.streams?.length || 0
        });

        if (!remoteMediaStreamRef.current) {
          remoteMediaStreamRef.current = new MediaStream();
        }

        // Avoid duplicate tracks
        const inboundStream = remoteMediaStreamRef.current;
        const exists = inboundStream.getTracks().some(t => t.id === event.track.id);
        if (!exists) {
          inboundStream.addTrack(event.track);
          console.log('➕ Added remote track to aggregated stream. Total tracks:', inboundStream.getTracks().length);
        }

        setRemoteStream(inboundStream);

        // Set up audio level monitoring for remote stream
        setupAudioLevelMonitoring(inboundStream, 'remote');
        setCallAccepted(true);
      };

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('🧊 Sending ICE candidate');
          socket.emit('ice-candidate', {
            to: callData.type === 'outgoing' ? callData.targetUserId : callData.fromUserId,
            candidate: event.candidate
          });
        } else {
          console.log('🧊 ICE gathering complete');
        }
      };

      peerConnectionRef.current = pc;

      // If this is an outgoing call, create offer
      if (callData.type === 'outgoing') {
        console.log('📞 Creating offer for outgoing call...');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log('📤 Sending offer');
        
        socket.emit('call-offer', {
          to: callData.targetUserId,
          from: user.username,
          fromUserId: user._id,
          offer: offer
        });
      }

      // If this is an incoming call, handle the offer
      if (callData.type === 'incoming' && callData.offer) {
        console.log('📞 Handling incoming call offer...');
        await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));

        // Apply any ICE candidates that arrived before remoteDescription was set
        if (pendingRemoteIceCandidatesRef.current.length > 0) {
          console.log(`🧊 Applying buffered ICE candidates: ${pendingRemoteIceCandidatesRef.current.length}`);
          for (const candidate of pendingRemoteIceCandidatesRef.current) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
              console.error('❌ Error applying buffered ICE candidate:', err);
            }
          }
          pendingRemoteIceCandidatesRef.current = [];
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log('📤 Sending answer');
        
        socket.emit('call-answer', {
          to: callData.fromUserId,
          answer: answer
        });
      }

    } catch (error) {
      console.error('❌ Error initializing call:', error);
      alert('Failed to access camera/microphone: ' + error.message);
      onEndCall();
    }
  };

  const handleCallAnswer = async (data) => {
    console.log('📥 Received call answer');
    if (peerConnectionRef.current && data.answer) {
      try {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
        console.log('✅ Remote description set successfully');

        // Apply any ICE candidates that arrived before remoteDescription was set
        if (pendingRemoteIceCandidatesRef.current.length > 0) {
          console.log(`🧊 Applying buffered ICE candidates (answer): ${pendingRemoteIceCandidatesRef.current.length}`);
          for (const candidate of pendingRemoteIceCandidatesRef.current) {
            try {
              await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
              console.error('❌ Error applying buffered ICE candidate after answer:', err);
            }
          }
          pendingRemoteIceCandidatesRef.current = [];
        }
      } catch (error) {
        console.error('❌ Error setting remote description:', error);
      }
    } else {
      console.warn('⚠️ No peer connection or answer data', {
        hasPeerConnection: !!peerConnectionRef.current,
        hasAnswer: !!data.answer
      });
    }
  };

  const handleIceCandidate = async (data) => {
    console.log('📥 Received ICE candidate');
    if (peerConnectionRef.current && data.candidate) {
      try {
        if (peerConnectionRef.current.remoteDescription) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
          console.log('✅ ICE candidate added successfully');
        } else {
          // Buffer until remote description is set
          pendingRemoteIceCandidatesRef.current.push(data.candidate);
          console.log('🧊 Buffered ICE candidate (no remoteDescription yet)');
        }
      } catch (error) {
        console.error('❌ Error adding ICE candidate:', error);
      }
    } else {
      console.warn('⚠️ No peer connection or candidate data', {
        hasPeerConnection: !!peerConnectionRef.current,
        hasCandidate: !!data.candidate
      });
    }
  };

  const handleCallEnded = () => {
    cleanup();
    onEndCall();
  };

  const endCall = () => {
    socket.emit('call-ended', {
      to: callData.type === 'outgoing' ? callData.targetUserId : callData.fromUserId
    });
    handleCallEnded();
  };

  const toggleVideo = () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
      }
    }
  };

  const toggleAudio = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
      }
    }
  };

  const setupAudioLevelMonitoring = (stream, type) => {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      
      analyser.fftSize = 256;
      source.connect(analyser);
      
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      if (type === 'local') {
        localAudioContextRef.current = audioContext;
        localAnalyserRef.current = analyser;
      } else {
        remoteAudioContextRef.current = audioContext;
        remoteAnalyserRef.current = analyser;
      }
      
      const updateAudioLevel = () => {
        if ((type === 'local' && localAnalyserRef.current) || 
            (type === 'remote' && remoteAnalyserRef.current)) {
          analyser.getByteFrequencyData(dataArray);
          
          // Calculate average volume
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
          }
          const average = sum / dataArray.length;
          const percentage = (average / 255) * 100;
          
          if (type === 'local') {
            setLocalAudioLevel(Math.round(percentage));
          } else {
            setRemoteAudioLevel(Math.round(percentage));
          }
          
          requestAnimationFrame(updateAudioLevel);
        }
      };
      
      updateAudioLevel();
      console.log(`🔊 Audio level monitoring setup for ${type} stream`);
    } catch (error) {
      console.error(`❌ Error setting up audio monitoring for ${type}:`, error);
    }
  };

  const setupAudioRecording = (stream) => {
    try {
      // Create audio-only stream for recording
      const audioOnlyStream = new MediaStream(stream.getAudioTracks());
      
      // Check if MediaRecorder supports the selected format
      const mimeType = `audio/${audioFormat}`;
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        console.warn(`❌ ${mimeType} not supported, falling back to webm`);
        setAudioFormat('webm');
      }

      const mediaRecorder = new MediaRecorder(audioOnlyStream, {
        mimeType: MediaRecorder.isTypeSupported(`audio/${audioFormat}`) ? `audio/${audioFormat}` : 'audio/webm'
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          
          // Convert chunk to base64 and send for fraud analysis
          const reader = new FileReader();
          reader.onload = () => {
            const base64Data = reader.result.split(',')[1]; // Remove data:audio/... prefix
            
            socket.emit('audio-chunk', {
              conversationId: callData.conversationId || `call_${user._id}_${Date.now()}`,
              audioData: base64Data,
              userId: user._id,
              format: audioFormat
            });
          };
          reader.readAsDataURL(event.data);
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error('❌ MediaRecorder error:', event.error);
      };

      console.log('🎙️ Audio recording setup complete');
    } catch (error) {
      console.error('❌ Error setting up audio recording:', error);
    }
  };

  const startAudioRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'inactive') {
      mediaRecorderRef.current.start(2000); // Record in 2-second chunks
      setIsRecording(true);
      console.log('🔴 Started audio recording for fraud detection');
    }
  };

  const stopAudioRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      console.log('⏹️ Stopped audio recording');
    }
  };

  const cleanup = () => {
    if (hasCleanedUpRef.current) {
      return;
    }
    hasCleanedUpRef.current = true;
    console.log('🧹 Cleaning up call resources');

    // Immediately detach media from elements to release capture indicators
    if (remoteVideoRef.current) {
      try { remoteVideoRef.current.srcObject = null; } catch (_) {}
    }
    if (localVideoRef.current) {
      try { localVideoRef.current.srcObject = null; } catch (_) {}
    }

    // Stop audio recording
    stopAudioRecording();

    // Proactively stop and remove senders/transceivers
    if (peerConnectionRef.current) {
      try {
        const pc = peerConnectionRef.current;
        pc.getSenders?.().forEach((sender) => {
          try { sender.replaceTrack?.(null); } catch (_) {}
          if (sender.track) {
            try { sender.track.stop(); } catch (_) {}
          }
          try { pc.removeTrack?.(sender); } catch (_) {}
        });
        pc.getTransceivers?.().forEach((t) => {
          try { t.direction = 'inactive'; } catch (_) {}
          try { t.stop?.(); } catch (_) {}
        });
      } catch (_) {}
    }

    // Stop local media tracks
    try {
      if (localStream) {
        localStream.getTracks().forEach(track => {
          try { track.stop(); } catch (_) {}
        });
      }
    } catch (_) {}

    // Close peer connection and clear handlers
    if (peerConnectionRef.current) {
      try {
        const pc = peerConnectionRef.current;
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.onicegatheringstatechange = null;
        pc.onicecandidateerror = null;
        pc.close();
      } catch (_) {}
    }

    // Clean up audio contexts
    try { localAudioContextRef.current?.close?.(); } catch (_) {}
    try { remoteAudioContextRef.current?.close?.(); } catch (_) {}

    setLocalStream(null);
    setRemoteStream(null);
    peerConnectionRef.current = null;
    remoteMediaStreamRef.current = null;
    pendingRemoteIceCandidatesRef.current = [];
    localAudioContextRef.current = null;
    remoteAudioContextRef.current = null;
    localAnalyserRef.current = null;
    remoteAnalyserRef.current = null;
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    setCallAccepted(false);
    setLocalAudioLevel(0);
    setRemoteAudioLevel(0);
    setIsRecording(false);
  };

  return (
    <div className="video-call-overlay">
      <div className="video-call-container">
        <div className="video-call-header">
          <h3>
            {callData.type === 'outgoing' ? 'Calling...' : `Call from ${callData.from}`}
          </h3>
          <button onClick={endCall} className="close-btn">×</button>
        </div>
        
        <div className="video-container">
          <div className="video-grid">
            {localStream && (
              <div className="video-wrapper">
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="my-video"
                  onLoadedMetadata={() => console.log('📺 Local video metadata loaded')}
                  onCanPlay={() => console.log('📺 Local video can play')}
                />
                <span className="video-label">
                  You
                  <div className="audio-level">
                    🎤 {localAudioLevel}%
                    <div className="level-bar">
                      <div 
                        className="level-fill" 
                        style={{width: `${Math.min(localAudioLevel, 100)}%`}}
                      ></div>
                    </div>
                  </div>
                </span>
              </div>
            )}
            
            {callAccepted && remoteStream && (
              <div className="video-wrapper">
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="user-video"
                  onLoadedMetadata={() => console.log('📺 Remote video metadata loaded')}
                  onCanPlay={() => console.log('📺 Remote video can play')}
                />
                <span className="video-label">
                  {callData.type === 'outgoing' ? 'Remote User' : callData.from}
                  <div className="audio-level">
                    🔊 {remoteAudioLevel}%
                    <div className="level-bar">
                      <div 
                        className="level-fill" 
                        style={{width: `${Math.min(remoteAudioLevel, 100)}%`}}
                      ></div>
                    </div>
                  </div>
                </span>
              </div>
            )}
          </div>
          
          {/* Debug info */}
          <div className="debug-info">
            <p>Local stream tracks: {localStream?.getTracks().length || 0}</p>
            <p>Remote stream tracks: {remoteStream?.getTracks().length || 0}</p>
            <p>Video enabled: {isVideoEnabled ? '✅' : '❌'}</p>
            <p>Audio enabled: {isAudioEnabled ? '✅' : '❌'}</p>
          </div>
        </div>

        <div className="call-controls">
          {/* Audio Format Selection */}
          <div className="audio-format-selector">
            <label>Audio Format:</label>
            <select 
              value={audioFormat} 
              onChange={(e) => setAudioFormat(e.target.value)}
              disabled={isRecording}
            >
              <option value="webm">WebM</option>
              <option value="wav">WAV</option>
              <option value="ogg">OGG</option>
            </select>
            <button 
              onClick={isRecording ? stopAudioRecording : startAudioRecording}
              className={`control-btn ${isRecording ? 'disabled' : ''}`}
              title="Toggle fraud detection recording"
            >
              {isRecording ? '🔴 Recording' : '⭕ Record'}
            </button>
          </div>

          {!callAccepted && callData.type === 'outgoing' && (
            <div className="connecting">
              <p>Connecting...</p>
            </div>
          )}

          {callAccepted && (
            <div className="call-actions">
              <button 
                onClick={toggleVideo} 
                className={`control-btn ${!isVideoEnabled ? 'disabled' : ''}`}
              >
                {isVideoEnabled ? '📹' : '📹̶'} Video
              </button>
              <button 
                onClick={toggleAudio} 
                className={`control-btn ${!isAudioEnabled ? 'disabled' : ''}`}
              >
                {isAudioEnabled ? '🎤' : '🎤̶'} Audio
              </button>
              <button onClick={endCall} className="call-btn end-call">
                End Call
              </button>
            </div>
          )}

          {!callAccepted && callData.type === 'incoming' && (
            <div className="call-actions">
              <button onClick={endCall} className="call-btn end-call">
                End Call
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VideoCall;