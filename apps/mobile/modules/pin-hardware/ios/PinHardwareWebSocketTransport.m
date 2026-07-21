#import "PinHardwareWebSocketTransport.h"

#import <SocketRocket/SRWebSocket.h>

@interface PinHardwareWebSocketTransport () <SRWebSocketDelegate>

@property(nonatomic, strong) SRWebSocket *socket;
@property(nonatomic, strong) dispatch_queue_t delegateQueue;

@end


@implementation PinHardwareWebSocketTransport

- (instancetype)initWithURL:(NSURL *)url {
  self = [super init];
  if (self) {
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    request.timeoutInterval = 15.0;
    _socket = [[SRWebSocket alloc] initWithURLRequest:request];
    _delegateQueue = dispatch_queue_create("ai.pin.tencent-asr.socketrocket", DISPATCH_QUEUE_SERIAL);
    _socket.delegate = self;
    _socket.delegateDispatchQueue = _delegateQueue;
  }
  return self;
}

- (void)open {
  [self.socket open];
}

- (void)sendData:(NSData *)data {
  NSError *error = nil;
  if (![self.socket sendData:data error:&error] && error != nil && self.onError != nil) {
    self.onError(error);
  }
}

- (void)sendText:(NSString *)text {
  NSError *error = nil;
  if (![self.socket sendString:text error:&error] && error != nil && self.onError != nil) {
    self.onError(error);
  }
}

- (void)close {
  [self.socket closeWithCode:SRStatusCodeGoingAway reason:nil];
}

- (void)webSocketDidOpen:(SRWebSocket *)webSocket {
  if (self.onOpen != nil) {
    self.onOpen();
  }
}

- (void)webSocket:(SRWebSocket *)webSocket didReceiveMessageWithString:(NSString *)string {
  if (self.onText != nil) {
    self.onText(string);
  }
}

- (void)webSocket:(SRWebSocket *)webSocket didReceiveMessageWithData:(NSData *)data {
  if (self.onData != nil) {
    self.onData(data);
  }
}

- (void)webSocket:(SRWebSocket *)webSocket didFailWithError:(NSError *)error {
  if (self.onError != nil) {
    self.onError(error);
  }
}

- (void)webSocket:(SRWebSocket *)webSocket
    didCloseWithCode:(NSInteger)code
              reason:(NSString *_Nullable)reason
            wasClean:(BOOL)wasClean {
  if (self.onClose != nil) {
    self.onClose(code, reason);
  }
}

@end
