extends CharacterBody2D

@export var speed: float = 300.0
var direction: Vector2 = Vector2.DOWN.rotated(randf_range(-PI/4, PI/4))
@onready var screen_size = get_viewport_rect().size
@onready var score_label = get_parent().get_node("ScoreLabel")

func _physics_process(delta: float) -> void:
	velocity = direction * speed
	var collision = move_and_collide(velocity * delta)
	
	if collision:
		# 碰到玩家就加分，并且反弹
		if collision.get_collider().name == "Player":
			score_label.text = str(int(score_label.text) + 1)
			# 根据碰撞点位置调整反弹方向，增加可玩性
			var hit_pos = collision.get_position()
			var player_center = collision.get_collider().position.x
			var offset = (hit_pos.x - player_center) / (collision.get_collider().rect_size.x / 2)
			direction = direction.bounce(collision.get_normal()).rotated(offset * PI/6)
		else:
			# 碰到墙反弹
			direction = direction.bounce(collision.get_normal())
	
	# 掉出屏幕底部，重置
	if position.y > screen_size.y + 20:
		reset_ball()

func reset_ball():
	position = Vector2(screen_size.x/2, screen_size.y/2)
	direction = Vector2.DOWN.rotated(randf_range(-PI/4, PI/4))
	score_label.text = "0"
