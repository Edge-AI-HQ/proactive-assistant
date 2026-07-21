#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Native WebSocket transport backed by the same SocketRocket binary used by
/// React Native. Tencent RTASR succeeds on this transport on physical iOS
/// devices where URLSessionWebSocketTask can fail before the opening frame.
@interface PinHardwareWebSocketTransport : NSObject

@property(nonatomic, copy, nullable) void (^onOpen)(void);
@property(nonatomic, copy, nullable) void (^onText)(NSString *text);
@property(nonatomic, copy, nullable) void (^onData)(NSData *data);
@property(nonatomic, copy, nullable) void (^onError)(NSError *error);
@property(nonatomic, copy, nullable) void (^onClose)(NSInteger code, NSString *_Nullable reason);

- (instancetype)initWithURL:(NSURL *)url;
- (void)open;
- (void)sendData:(NSData *)data NS_SWIFT_NAME(send(data:));
- (void)sendText:(NSString *)text NS_SWIFT_NAME(send(text:));
- (void)close;

@end

NS_ASSUME_NONNULL_END
