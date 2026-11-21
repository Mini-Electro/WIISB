import { useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  Participant,
  LocalParticipant,
  type VideoTrack,
  type AudioTrack,
  type RemoteParticipant,
} from "livekit-client";
import {
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  PhoneOff,
  Video,
  VideoOff,
  ScreenShare,
  ScreenShareOff,
  Maximize2,
  Settings2,
  Radio,
} from "lucide-react";
import { api } from "../api";
import type { Channel } from "../types";
import { Avatar, IconButton, ErrorText, Field, errorMessage } from "./UI";
export function Call({
  channel,
  onClose,
}: {
  channel: Channel;
  onClose: () => void;
}) {
  const [room] = useState(
    () =>
      new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
  );
  const [status, setStatus] = useState("Connecting"),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(""),
    [deaf, setDeaf] = useState(false),
    [settings, setSettings] = useState(false),
    [ptt, setPtt] = useState(false),
    [resolution, setResolution] = useState("1080"),
    [fps, setFps] = useState("30"),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [focused, setFocused] = useState("");
  const container = useRef<HTMLDivElement>(null),
    leaving = useRef(false);
  useEffect(() => {
    let active = true;
    const update = () => {
      if (active) setRevision((r) => r + 1);
    };
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.ActiveSpeakersChanged,
      RoomEvent.ConnectionQualityChanged,
    ] as const;
    for (const event of events) room.on(event, update);
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (active) setStatus(state);
    });
    void (async () => {
      try {
        const access = await api.post("/v1/voice/" + channel.id + "/token");
        if (!active) return;
        await room.connect(access.url, access.token);
        if (!active) {
          await room.disconnect();
          return;
        }
        await room.startAudio();
        await room.localParticipant.setMicrophoneEnabled(true);
        update();
        setDevices(await Room.getLocalDevices());
      } catch (e) {
        if (active) {
          setError(errorMessage(e));
          setStatus("Disconnected");
        }
      }
    })();
    return () => {
      active = false;
      for (const event of events) room.off(event, update);
      void room.disconnect();
    };
  }, [room, channel.id]);
  useEffect(() => {
    if (!ptt) return;
    void room.localParticipant.setMicrophoneEnabled(false);
    const down = (e: KeyboardEvent) => {
      if (
        e.code === "KeyV" &&
        !e.repeat &&
        !(
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        )
      ) {
        e.preventDefault();
        void room.localParticipant
          .setMicrophoneEnabled(true)
          .catch((e) => setError(errorMessage(e)));
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "KeyV")
        void room.localParticipant.setMicrophoneEnabled(false);
    };
    const blur = () => void room.localParticipant.setMicrophoneEnabled(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [ptt, room]);
  const action = async (fn: () => Promise<any>) => {
    setError("");
    try {
      await fn();
      setRevision((r) => r + 1);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const mic = room.localParticipant.isMicrophoneEnabled,
    camera = room.localParticipant.isCameraEnabled,
    sharing = room.localParticipant.isScreenShareEnabled;
  const participants: Participant[] = [
    room.localParticipant,
    ...room.remoteParticipants.values(),
  ];
  return (
    <section className="call-panel" ref={container}>
      <header>
        <span>
          <Radio size={17} /> {channel.name}{" "}
          <small className="muted">{status}</small>
        </span>
        <IconButton
          title="Fullscreen call"
          onClick={() => void container.current?.requestFullscreen()}
        >
          <Maximize2 size={17} />
        </IconButton>
      </header>
      <ErrorText error={error} />
      <div className={"call-grid " + (focused ? "focused" : "")}>
        {participants.map((p) => (
          <ParticipantTile
            key={p.identity || "local"}
            participant={p}
            deaf={deaf}
            isLocal={p === room.localParticipant}
            focused={focused === p.identity}
            onFocus={() => setFocused(focused === p.identity ? "" : p.identity)}
          />
        ))}
        {!room.remoteParticipants.size &&
          status === ConnectionState.Connected && (
            <p className="call-waiting">
              You’re here. Invite someone to join the conversation.
            </p>
          )}
      </div>
      <div className="call-controls">
        <IconButton
          title={mic ? "Mute microphone" : "Unmute microphone"}
          active={!mic}
          onClick={() =>
            void action(() => room.localParticipant.setMicrophoneEnabled(!mic))
          }
        >
          <>{mic ? <Mic size={20} /> : <MicOff size={20} />}</>
        </IconButton>
        <IconButton
          title={deaf ? "Enable call audio" : "Deafen call audio"}
          active={deaf}
          onClick={() => setDeaf(!deaf)}
        >
          {deaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
        </IconButton>
        <IconButton
          title={camera ? "Turn camera off" : "Turn camera on"}
          active={camera}
          onClick={() =>
            void action(() => room.localParticipant.setCameraEnabled(!camera))
          }
        >
          {camera ? <Video size={20} /> : <VideoOff size={20} />}
        </IconButton>
        <IconButton
          title={
            sharing
              ? "Stop sharing screen"
              : "Choose a screen or window to share"
          }
          active={sharing}
          onClick={() =>
            void action(async () => {
              if (!sharing && !navigator.mediaDevices?.getDisplayMedia)
                throw new Error(
                  "Screen capture is unavailable in this runtime. Use a supported Windows WebView2 version.",
                );
              await room.localParticipant.setScreenShareEnabled(!sharing, {
                audio: true,
                resolution: {
                  width: resolution === "720" ? 1280 : 1920,
                  height: Number(resolution),
                  frameRate: Number(fps),
                },
              });
            })
          }
        >
          {sharing ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}
        </IconButton>
        <IconButton
          title="Call device settings"
          active={settings}
          onClick={() => setSettings(!settings)}
        >
          <Settings2 size={20} />
        </IconButton>
        <button
          className="hangup"
          onClick={() => {
            leaving.current = true;
            void room.disconnect().then(onClose);
          }}
          aria-label="Disconnect call"
        >
          <PhoneOff size={21} />
        </button>
      </div>
      {sharing && (
        <div className="sharing-indicator">
          Your screen is being shared. Use Stop sharing to end capture
          immediately.
        </div>
      )}
      {settings && (
        <div className="call-settings">
          <div className="field-grid">
            {(["audioinput", "audiooutput", "videoinput"] as const).map(
              (kind) => (
                <Field
                  key={kind}
                  label={
                    {
                      audioinput: "Microphone",
                      audiooutput: "Speaker",
                      videoinput: "Camera",
                    }[kind]
                  }
                >
                  <select
                    defaultValue={room.getActiveDevice(kind)}
                    onChange={(e) =>
                      void action(() =>
                        room.switchActiveDevice(kind, e.target.value),
                      )
                    }
                  >
                    {devices
                      .filter((d) => d.kind === kind)
                      .map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || d.kind}
                        </option>
                      ))}
                  </select>
                </Field>
              ),
            )}
            <Field label="Screen share quality">
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              >
                <option value="720">720p</option>
                <option value="1080">1080p</option>
              </select>
            </Field>
            <Field label="Screen share frame rate">
              <select value={fps} onChange={(e) => setFps(e.target.value)}>
                {["15", "30", "60"].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </Field>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={ptt}
              onChange={(e) => setPtt(e.target.checked)}
            />{" "}
            Push to talk — hold V while this app is focused
          </label>
          <p className="muted">
            Capture quality depends on your display, device, and network. The
            operating system asks what to share.
          </p>
        </div>
      )}
    </section>
  );
}
function ParticipantTile({
  participant: p,
  isLocal,
  focused,
  onFocus,
  deaf,
}: {
  participant: Participant;
  isLocal: boolean;
  focused: boolean;
  onFocus: () => void;
  deaf: boolean;
}) {
  const screen = p.getTrackPublication(Track.Source.ScreenShare),
    camera = p.getTrackPublication(Track.Source.Camera);
  const video =
    screen && !screen.isMuted
      ? screen.track
      : camera && !camera.isMuted
        ? camera.track
        : undefined;
  const audio = isLocal
    ? []
    : [...p.audioTrackPublications.values()]
        .map((v) => v.track)
        .filter(Boolean);
  const videoRef = useRef<HTMLVideoElement>(null),
    audioRef = useRef<HTMLDivElement>(null),
    [volume, setVolume] = useState(100);
  useEffect(() => {
    if (video && videoRef.current) {
      video.attach(videoRef.current);
      return () => {
        video.detach();
      };
    }
  }, [video]);
  useEffect(() => {
    const elements = audio.map((track) => {
      const element = track!.attach();
      audioRef.current?.appendChild(element);
      return { element, track };
    });
    return () => {
      for (const { element, track } of elements) {
        track!.detach(element);
        element.remove();
      }
    };
  }, [audio.map((t) => t!.sid).join(":")]);
  useEffect(() => {
    for (const element of Array.from(
      audioRef.current?.querySelectorAll("audio") || [],
    ))
      element.muted = deaf;
  }, [deaf, audio.map((t) => t!.sid).join(":")]);
  return (
    <div
      className={
        "participant " +
        (p.isSpeaking ? "speaking " : "") +
        (focused ? "pinned-participant" : "")
      }
    >
      <button
        className="participant-view"
        onClick={onFocus}
        title="Click to focus participant"
      >
        {video ? (
          <video ref={videoRef} autoPlay playsInline muted={isLocal} />
        ) : (
          <Avatar user={{ display_name: p.name || "Connecting" }} size={58} />
        )}
        <span>
          {p.name || "You"}
          {isLocal ? " (you)" : ""}
          {!p.isMicrophoneEnabled && <MicOff size={13} />}
        </span>
      </button>
      <div hidden ref={audioRef} />
      {!isLocal && (
        <label className="participant-volume">
          Volume
          <input
            aria-label={`${p.name} volume`}
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={(e) => {
              setVolume(Number(e.target.value));
              (p as RemoteParticipant).setVolume(Number(e.target.value) / 100);
            }}
          />
        </label>
      )}
    </div>
  );
}
